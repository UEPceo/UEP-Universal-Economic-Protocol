/**
 * UEP-API-001.3 — spend inbox drained by the existing Groth16 prover.
 * A proved spend is not network-final. Finality still requires quorum apply.
 */
import { SmtEconomicState } from "../lab/uep37-smt-economic-state.ts";
import {
  bindCircuitAccounts,
  defaultAlignedAccounts,
  labParty,
  proveManyParallel,
  type SpendProofArtifact,
} from "../lab/uep38-zk-state-transition.ts";
import { nodeApplyVerifiedTransfer } from "../lab/uep38-node-verify.ts";
import type { SpendSubmitInput } from "./uep-service-backends.ts";
import type { NodeIdentity } from "../lab/node-identity.ts";
import { createHash } from "node:crypto";
import { generateP4Bootstrap } from "../lab/uep38-p4-process-node.ts";
import { BN254_FR, identityFromBoot, signP4Spend, verifyP4SpendCert } from "../lab/uep38-p4-spend-cert.ts";

export type QueuedSpend = SpendSubmitInput & { spendId: string; amountBig: bigint };

export type ProvedSpend = {
  spendId: string;
  status: "PROVED";
  final: boolean;
  oldRoot: string;
  newRoot: string;
  publicInputs: number;
  proofBytes: number;
};

export class Groth16SpendQueue {
  readonly state: SmtEconomicState;
  private pending: QueuedSpend[] = [];
  readonly proved: ProvedSpend[] = [];
  private proofs = new Map<string, string>();

  constructor(depth: 4 | 32 = 32) {
    this.state = SmtEconomicState.genesis(
      { alice: 10_000n, bob: 0n, carol: 10_000n, dave: 0n, erin: 10_000n, frank: 0n },
      { testOnlyDepth: depth, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    bindCircuitAccounts(this.state, defaultAlignedAccounts());
  }

  accept(input: SpendSubmitInput): { accepted: boolean; reason?: string } {
    const who = input.sender;
    if (who !== "alice" && who !== "carol" && who !== "erin") {
      return { accepted: false, reason: "SENDER_NOT_CIRCUIT_ALIGNED" };
    }
    const party = labParty(who);
    if (input.recipient !== party.recipientLabel) {
      return { accepted: false, reason: "RECIPIENT_NOT_ALIGNED" };
    }
    const amount = BigInt(input.amount);
    if (this.state.balance(who) < amount) return { accepted: false, reason: "INSUFFICIENT" };
    this.pending.push({
      ...input,
      amountBig: amount,
      spendId: `${input.domainId}|${input.sender}|${input.nonce}`,
    });
    return { accepted: true };
  }

  async provePending(): Promise<{ ok: boolean; spends: ProvedSpend[]; reason?: string }> {
    if (this.pending.length === 0) return { ok: false, spends: [], reason: "EMPTY" };
    const batch = this.pending.splice(0, this.pending.length);
    const proved = await proveManyParallel(
      this.state,
      batch.map((s) => ({ who: s.sender, ids: labParty(s.sender), amount: s.amountBig })),
    );
    if (!proved.ok) {
      this.pending.unshift(...batch);
      return { ok: false, spends: [], reason: proved.reason ?? "PROVE_FAIL" };
    }
    const out: ProvedSpend[] = [];
    for (let i = 0; i < batch.length; i++) {
      const art = proved.arts[i] as SpendProofArtifact;
      const applied = nodeApplyVerifiedTransfer(this.state, labParty(batch[i]!.sender), batch[i]!.amountBig, art);
      if (!applied.ok) return { ok: false, spends: out, reason: applied.reason };
      const row: ProvedSpend = {
        spendId: batch[i]!.spendId,
        status: "PROVED",
        final: false,
        oldRoot: art.oldRootProof,
        newRoot: art.newRootProof,
        publicInputs: art.publicInputsHex.length,
        proofBytes: art.proofHex.length / 2,
      };
      this.proofs.set(row.spendId, art.proofHex);
      this.proved.push(row);
      out.push(row);
    }
    return { ok: true, spends: out };
  }

  proofOf(spendId: string): string | undefined {
    return this.proofs.get(spendId);
  }
}

export const SPEND_QUORUM_N = 4;
export const SPEND_QUORUM_NEED = 3;

/** Canonical BN254 field element derived from a lab spendId (statement fields must be canonical field hex). */
function spendIdFieldHex(spendId: string): string {
  const h = BigInt("0x" + createHash("sha256").update(spendId).digest("hex")) % BN254_FR;
  return h.toString(16).padStart(64, "0");
}
const ZERO_FIELD = "00".repeat(32);

export class SpendQuorum {
  readonly members: NodeIdentity[];
  private pub = new Map<string, string>();
  constructor() {
    const boot = generateP4Bootstrap(4);
    this.members = boot.nodes.map((n) => identityFromBoot(n.id, n.privateKeyHex!, n.publicKeyHex));
    this.pub = new Map(boot.nodes.map((n) => [n.id, n.publicKeyHex]));
  }
  vote(nodeId: string, spendId: string, newRoot: string, _proofHex: string): { nodeId: string; signature: string } {
    const id = this.members.find((m) => m.nodeId === nodeId);
    if (!id) throw new Error("NOT_COMMITTEE");
    return signP4Spend(id, { domainId: "lab", spendId, oldRoot: ZERO_FIELD, newRoot, nullifier: spendIdFieldHex(spendId), amount: "0", fee: "0", senderId: "0", recipientId: "0", treasuryId: "0", assetId: "0" });
  }
  commit(spendId: string, newRoot: string, _proofHex: string, votes: { nodeId: string; signature: string }[]): { ok: boolean; final: boolean; reason?: string } {
    const r = verifyP4SpendCert(this.pub, { domainId: "lab", spendId, oldRoot: ZERO_FIELD, newRoot, nullifier: spendIdFieldHex(spendId), amount: "0", fee: "0", senderId: "0", recipientId: "0", treasuryId: "0", assetId: "0", votes });
    return r.ok ? { ok: true, final: true } : { ok: false, final: false, reason: r.reason };
  }
}
