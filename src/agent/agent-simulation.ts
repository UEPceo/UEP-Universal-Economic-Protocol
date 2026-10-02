/**
 * UEP-Agent economic simulation (experimental).
 * Simulated wallet + service marketplace — not consensus.
 */

import {
  type AgentCapability,
  type AgentKeypair,
  authorizeAgentAction,
  createAgentKeypair,
  debitBudget,
  issueCapability,
  revokeCapability,
  signAgent,
  verifyAgent,
  agentAttemptsPermissionChange,
} from "./agent-identity.ts";
import { AgentNonceStore } from "./agent-nonce.ts";
import {
  createOwnerKeypair,
  issueSignedCapability,
  type SignedCapability,
  type OwnerKeypair,
} from "./agent-capability-cert.ts";
import {
  signActionRequest,
  authorizeSignedAction,
} from "./agent-action-request.ts";

export type ServiceOffer = {
  serviceId: string;
  name: string;
  price: bigint;
  asset: string;
  quality: number; // 0..1
};

export type SimWallet = {
  ownerId: string;
  balances: Map<string, bigint>;
};

export type ContractRecord = {
  agentId: string;
  serviceId: string;
  amount: bigint;
  result: string;
  verified: boolean;
  settled: boolean;
  error?: string;
};

export type SimStats = {
  contracts: number;
  settled: number;
  rejected: number;
  abuseAttempts: number;
  totalPaid: bigint;
};

export class AgentEconomySim {
  services = new Map<string, ServiceOffer>();
  wallets = new Map<string, SimWallet>();
  capabilities = new Map<string, AgentCapability>();
  signedCapabilities = new Map<string, SignedCapability>();
  owners = new Map<string, OwnerKeypair>();
  keypairs = new Map<string, AgentKeypair>();
  nonces = new AgentNonceStore({ ttlMs: 60_000, sequenceWindow: 1000 });
  agentSequences = new Map<string, number>();
  contracts: ContractRecord[] = [];
  stats: SimStats = {
    contracts: 0,
    settled: 0,
    rejected: 0,
    abuseAttempts: 0,
    totalPaid: 0n,
  };

  registerService(offer: ServiceOffer): void {
    this.services.set(offer.serviceId, offer);
  }

  createOwnerWallet(ownerId: string, asset: string, balance: bigint): void {
    const w = this.wallets.get(ownerId) ?? { ownerId, balances: new Map() };
    w.balances.set(asset, (w.balances.get(asset) ?? 0n) + balance);
    this.wallets.set(ownerId, w);
  }

  spawnAgent(opts: {
    agentId: string;
    ownerId: string;
    spendingLimit: bigint;
    allowedServices: string[];
    allowedAssets: string[];
    ttlMs?: number;
  }): AgentKeypair {
    const kp = createAgentKeypair(opts.agentId);
    this.keypairs.set(opts.agentId, kp);
    let owner = this.owners.get(opts.ownerId);
    if (!owner) {
      owner = createOwnerKeypair(opts.ownerId);
      this.owners.set(opts.ownerId, owner);
    }
    const signed = issueSignedCapability({
      owner,
      agentId: opts.agentId,
      agentPublicKeyHex: kp.publicKeyHex,
      permissions: [
        "discover_services",
        "compare_offers",
        "contract_service",
        "pay",
        "verify_result",
        "settle",
      ],
      spendingLimit: opts.spendingLimit,
      allowedAssets: opts.allowedAssets,
      allowedServices: opts.allowedServices,
      ttlMs: opts.ttlMs ?? 60 * 60 * 1000,
    });
    this.signedCapabilities.set(opts.agentId, signed);
    this.capabilities.set(opts.agentId, signed.capability);
    this.agentSequences.set(opts.agentId, 0);
    return kp;
  }

  listServices(): ServiceOffer[] {
    return [...this.services.values()];
  }

  /**
   * Full agent lifecycle: discover → compare → contract → pay → verify → settle.
   */
  agentRun(
    agentId: string,
    nonce: string,
    prefer?: { maxPrice?: bigint; minQuality?: number },
  ): ContractRecord {
    const cap = this.capabilities.get(agentId);
    const kp = this.keypairs.get(agentId);
    if (!cap || !kp) {
      this.stats.rejected++;
      return {
        agentId,
        serviceId: "",
        amount: 0n,
        result: "",
        verified: false,
        settled: false,
        error: "UNKNOWN_AGENT",
      };
    }

    const nr = this.nonces.checkAndConsume(agentId, nonce);
    if (!nr.ok) {
      this.stats.rejected++;
      this.stats.abuseAttempts++;
      return {
        agentId,
        serviceId: "",
        amount: 0n,
        result: "",
        verified: false,
        settled: false,
        error: nr.reason,
      };
    }

    // discover
    let auth = authorizeAgentAction(cap, { permission: "discover_services" });
    if (!auth.ok) {
      this.stats.rejected++;
      return emptyFail(agentId, auth.reason);
    }

    const offers = this.listServices().filter(
      (s) =>
        (cap.allowedServices.includes(s.serviceId) ||
          cap.allowedServices.includes("*")) &&
        (prefer?.maxPrice === undefined || s.price <= prefer.maxPrice) &&
        (prefer?.minQuality === undefined || s.quality >= prefer.minQuality),
    );
    if (offers.length === 0) {
      this.stats.rejected++;
      return emptyFail(agentId, "NO_OFFERS");
    }

    // compare — pick best quality/price
    auth = authorizeAgentAction(cap, { permission: "compare_offers" });
    if (!auth.ok) {
      this.stats.rejected++;
      return emptyFail(agentId, auth.reason);
    }
    offers.sort((a, b) => {
      const sa = a.quality / (Number(a.price) + 1);
      const sb = b.quality / (Number(b.price) + 1);
      return sb - sa;
    });
    const chosen = offers[0]!;

    auth = authorizeAgentAction(cap, {
      permission: "contract_service",
      serviceId: chosen.serviceId,
    });
    if (!auth.ok) {
      this.stats.rejected++;
      this.stats.abuseAttempts++;
      return emptyFail(agentId, auth.reason);
    }

    const seq = (this.agentSequences.get(agentId) ?? 0) + 1;
    this.agentSequences.set(agentId, seq);
    const payNonce = `${nonce}:pay:${seq}`;
    const signedAct = signActionRequest(kp, {
      agentId,
      permission: "pay",
      amount: chosen.price,
      asset: chosen.asset,
      serviceId: chosen.serviceId,
      nonce: payNonce,
      sequence: seq,
      ts: Date.now(),
    });
    // Consume pay nonce + authorize limits; capability may be owner-signed
    const signedCap = this.signedCapabilities.get(agentId);
    const gate = authorizeSignedAction({
      signed: signedAct,
      capability: this.capabilities.get(agentId)!,
      signedCapability: signedCap,
      nonces: this.nonces,
    });
    if (!gate.ok) {
      this.stats.rejected++;
      this.stats.abuseAttempts++;
      return emptyFail(agentId, gate.reason);
    }
    auth = gate;

    const wallet = this.wallets.get(cap.ownerId);
    if (!wallet) {
      this.stats.rejected++;
      return emptyFail(agentId, "NO_WALLET");
    }
    const bal = wallet.balances.get(chosen.asset) ?? 0n;
    if (bal < chosen.price) {
      this.stats.rejected++;
      return emptyFail(agentId, "INSUFFICIENT_OWNER_FUNDS");
    }

    // pay from owner wallet under agent authorization (not agent-held funds)
    wallet.balances.set(chosen.asset, bal - chosen.price);
    this.capabilities.set(agentId, debitBudget(cap, chosen.price));
    this.stats.contracts++;
    this.stats.totalPaid += chosen.price;

    const result = `RESULT:${chosen.serviceId}:${chosen.price}`;
    const body = `${agentId}|${chosen.serviceId}|${result}|${nonce}`;
    const sig = signAgent(kp, body);
    const verified = verifyAgent(kp.publicKeyHex, body, sig);

    auth = authorizeAgentAction(this.capabilities.get(agentId)!, {
      permission: "verify_result",
      serviceId: chosen.serviceId,
    });
    if (!auth.ok || !verified) {
      this.stats.rejected++;
      return {
        agentId,
        serviceId: chosen.serviceId,
        amount: chosen.price,
        result,
        verified: false,
        settled: false,
        error: auth.ok ? "VERIFY_FAIL" : auth.reason,
      };
    }

    auth = authorizeAgentAction(this.capabilities.get(agentId)!, {
      permission: "settle",
      serviceId: chosen.serviceId,
    });
    if (!auth.ok) {
      this.stats.rejected++;
      return {
        agentId,
        serviceId: chosen.serviceId,
        amount: chosen.price,
        result,
        verified: true,
        settled: false,
        error: auth.reason,
      };
    }

    this.stats.settled++;
    const rec: ContractRecord = {
      agentId,
      serviceId: chosen.serviceId,
      amount: chosen.price,
      result,
      verified: true,
      settled: true,
    };
    this.contracts.push(rec);
    return rec;
  }

  /** Abuse helpers for tests */
  tryOverspend(agentId: string, amount: bigint): string {
    const cap = this.capabilities.get(agentId);
    if (!cap) return "UNKNOWN_AGENT";
    const a = authorizeAgentAction(cap, { permission: "pay", amount, asset: "UEP-UNIT" });
    if (!a.ok) {
      this.stats.abuseAttempts++;
      return a.reason;
    }
    return "UNEXPECTED_OK";
  }

  tryRevoked(agentId: string): string {
    const cap = this.capabilities.get(agentId);
    if (!cap) return "UNKNOWN_AGENT";
    this.capabilities.set(agentId, revokeCapability(cap));
    const a = authorizeAgentAction(this.capabilities.get(agentId)!, {
      permission: "pay",
      amount: 1n,
    });
    if (!a.ok) {
      this.stats.abuseAttempts++;
      return a.reason;
    }
    return "UNEXPECTED_OK";
  }

  trySelfEscalate(agentId: string): string {
    const r = agentAttemptsPermissionChange();
    this.stats.abuseAttempts++;
    return r.ok ? "UNEXPECTED_OK" : r.reason;
  }
}

function emptyFail(agentId: string, error: string): ContractRecord {
  return {
    agentId,
    serviceId: "",
    amount: 0n,
    result: "",
    verified: false,
    settled: false,
    error,
  };
}

/** Run N agents with varied goals against a service catalog. */
export function runAgentExperiment(agentCount: number): {
  stats: SimStats;
  contracts: ContractRecord[];
  agents: string[];
} {
  const sim = new AgentEconomySim();
  sim.registerService({
    serviceId: "compute-a",
    name: "Compute A",
    price: 10n,
    asset: "UEP-UNIT",
    quality: 0.8,
  });
  sim.registerService({
    serviceId: "compute-b",
    name: "Compute B",
    price: 25n,
    asset: "UEP-UNIT",
    quality: 0.95,
  });
  sim.registerService({
    serviceId: "storage-x",
    name: "Storage X",
    price: 5n,
    asset: "UEP-UNIT",
    quality: 0.7,
  });
  sim.registerService({
    serviceId: "oracle-y",
    name: "Oracle Y",
    price: 15n,
    asset: "UEP-UNIT",
    quality: 0.85,
  });

  const agents: string[] = [];
  for (let i = 0; i < agentCount; i++) {
    const ownerId = `owner-${i % 5}`;
    if (!sim.wallets.has(ownerId)) {
      sim.createOwnerWallet(ownerId, "UEP-UNIT", 10_000n);
    }
    const agentId = `agent-${i}`;
    agents.push(agentId);
    const services =
      i % 3 === 0
        ? ["compute-a", "compute-b"]
        : i % 3 === 1
          ? ["storage-x", "oracle-y"]
          : ["*"];
    sim.spawnAgent({
      agentId,
      ownerId,
      spendingLimit: BigInt(20 + (i % 30)),
      allowedServices: services,
      allowedAssets: ["UEP-UNIT"],
    });
    const nonce = `nonce-${i}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sim.agentRun(agentId, nonce, {
      maxPrice: BigInt(5 + (i % 25)),
      minQuality: 0.6,
    });
  }

  // intentional abuse probes
  if (agents[0]) sim.tryOverspend(agents[0], 1_000_000n);
  if (agents[1]) {
    sim.tryRevoked(agents[1]);
    sim.agentRun(agents[1], `replay-try-${Date.now()}`, {});
  }
  if (agents[2]) sim.trySelfEscalate(agents[2]);
  // nonce replay
  if (agents[3]) {
    const n = "fixed-nonce-replay-test";
    sim.agentRun(agents[3], n, {});
    sim.agentRun(agents[3], n, {});
  }

  return { stats: sim.stats, contracts: sim.contracts, agents };
}
