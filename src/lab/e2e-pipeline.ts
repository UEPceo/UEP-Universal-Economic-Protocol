/**
 * UEP-32 E2E pipeline (lab, structural proving optional):
 *
 * PaymentRequest → SpendIntent → ExecutionEngine → NodeEnvelope → Replica
 *
 * Does not require Groth16 for structural path (requireProof: false).
 * ZK path can be enabled when uep-zk is available.
 */

import { Fr } from "../core/field.ts";
import { ExecutionEngine, type SpendIntent } from "./execution-engine.ts";
import {
  createPaymentRequest,
  encodePaymentRequestUri,
  type MerchantMacKey,
} from "./payment-request.ts";
import { enqueueFromPaymentUri } from "./payment-to-intent.ts";
import { DomainCodeName } from "./address-v2.ts";
import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
} from "./node-identity.ts";
import { LabNode } from "./node-protocol.ts";
import { AuthNetworkNode, sleep } from "./node-auth-transport.ts";
import { assertEngineProofPolicy, type NetworkProfile } from "./network-profile.ts";
import { VerifyingKeyRegistry, pinProverArtifact } from "./verifying-key-registry.ts";

export type E2EResult = {
  ok: boolean;
  error?: string;
  paymentUri?: string;
  intentId?: string;
  transitionIds: string[];
  sequencerRoot?: string;
  replicaRoot?: string;
  rootsMatch?: boolean;
};

/**
 * Run one payment through engine + authenticated multi-node replication.
 */
export async function runPaymentToReplicaE2E(opts?: {
  amount?: bigint;
  requireProof?: boolean;
  /** Network profile; TESTNET-ZK forbids requireProof=false. */
  profile?: NetworkProfile;
  /** Replica must Groth16-verify (default: same as requireProof). */
  requireZkVerifyOnReplica?: boolean;
}): Promise<E2EResult> {
  const amount = opts?.amount ?? 1500n;
  const requireProof = opts?.requireProof === true;
  const profile = opts?.profile ?? (requireProof ? "DEV-ZK" : "DEV-STRUCTURAL");
  assertEngineProofPolicy(profile, requireProof);
  const requireZkVerify =
    opts?.requireZkVerifyOnReplica ?? requireProof;

  const eng = new ExecutionEngine({
    depth: 4,
    profile: "local",
    requireProof,
    proveConcurrency: 1,
    oneInFlightPerSender: true,
    domainCode: DomainCodeName.earth,
  });
  eng.registerAccount("alice", {
    id: Fr.from(111n),
    secret: Fr.from(11n),
    salt: Fr.from(22n),
    blinding: Fr.from(3n),
    balance: 100_000n,
  });
  eng.registerAccount("merchant", {
    id: Fr.from(222n),
    secret: Fr.from(33n),
    salt: Fr.from(44n),
    blinding: Fr.from(4n),
    balance: 0n,
  });

  const merchant: MerchantMacKey = {
    kid: "e2e-shop",
    key: "e2e-merchant-secret-key!!32b",
  };
  const pr = createPaymentRequest({
    networkId: "local",
    domainCode: DomainCodeName.earth,
    addressId: Fr.from(222n),
    assetId: Fr.from(1n),
    amount,
    orderId: `e2e-${Date.now()}`,
    merchant,
  });
  const uri = encodePaymentRequestUri(pr);
  const enq = enqueueFromPaymentUri(eng, "alice", uri, merchant);
  if (!enq.ok) {
    return { ok: false, error: enq.error, transitionIds: [], paymentUri: uri };
  }

  const round = await eng.runRound();
  const commits = round.commits.filter((c) => c.ok);
  const proved = round.proved;
  if (commits.length === 0 || proved.length === 0) {
    return {
      ok: false,
      error: round.failed[0]?.error ?? "NO_COMMIT",
      transitionIds: [],
      paymentUri: uri,
      intentId: enq.intent.id,
    };
  }

  // Multi-node: sequencer + replica with auth handshake
  const seqId = createNodeIdentity("e2e-seq");
  const repId = createNodeIdentity("e2e-rep");
  const registry = new NodeRegistry();
  registry.register(
    registryFromIdentity(seqId, {
      networkId: "local",
      domainId: DomainCodeName.earth,
      role: "sequencer",
    }),
  );
  registry.register(
    registryFromIdentity(repId, {
      networkId: "local",
      domainId: DomainCodeName.earth,
      role: "replica",
    }),
  );

  // Pin verifying key from prover artifact (genesis/config simulation)
  const vkRegistry = new VerifyingKeyRegistry();
  if (requireZkVerify) {
    const art = proved[0]!;
    if (!art.vkId || !art.vkHex) {
      return {
        ok: false,
        error: "PROVER_MISSING_VK",
        transitionIds: proved.map((j) => j.transitionId),
        paymentUri: uri,
        intentId: enq.intent.id,
      };
    }
    pinProverArtifact(vkRegistry, {
      networkId: "local",
      vkId: art.vkId,
      vkHex: art.vkHex,
      label: art.vkId,
      profile,
    });
  }

  const labOpts = {
    requireZkVerify,
    vkRegistry: requireZkVerify ? vkRegistry : undefined,
    requirePinnedVkId: profile === "TESTNET-ZK",
  };

  const seq = new AuthNetworkNode({
    lab: new LabNode(
      seqId,
      "local",
      DomainCodeName.earth,
      seqId.publicKeyHex,
      seqId.nodeId,
      labOpts,
    ),
    registry,
    isSequencer: true,
    role: "sequencer",
  });
  const rep = new AuthNetworkNode({
    lab: new LabNode(
      repId,
      "local",
      DomainCodeName.earth,
      seqId.publicKeyHex,
      seqId.nodeId,
      labOpts,
    ),
    registry,
    isSequencer: false,
    role: "replica",
  });

  try {
    const seqPort = await seq.start();
    await rep.start();
    await rep.connectToSequencer("127.0.0.1", seqPort);
    await sleep(30);

    const transitionIds: string[] = [];
    // Seed canonical Fr roots from first proved job (ZK path — no GENESIS)
    if (requireZkVerify && proved.length > 0) {
      const first = proved[0]!;
      const seed = first.oldStateRoot;
      const seedNf = first.oldNullifierRoot ?? first.publicInputsHex?.[2];
      for (const n of [seq, rep]) {
        n.lab.stateRoot = seed;
        if (seedNf) n.lab.nullifierRoot = seedNf!;
      }
    }

    for (const job of proved) {
      const tid = job.transitionId;
      transitionIds.push(tid);
      const prev = seq.lab.stateRoot;
      const nextRoot = job.newStateRoot || eng.stateRoot || `ENG_${tid}`;
      const r = seq.commitAndBroadcast({
        previousStateRoot: prev,
        newStateRoot: nextRoot,
        transitionId: tid,
        nullifier: job.nullifier,
        previousNullifierRoot: job.oldNullifierRoot ?? job.publicInputsHex?.[2],
        newNullifierRoot: job.newNullifierRoot,
        proofHex: job.proofHex,
        publicInputsHex: job.publicInputsHex,
        vkHex: job.vkHex,
        vkId: job.vkId,
        transactionCommitment: job.publicInputsHex?.[11],
      });
      if (!r.ok) {
        return {
          ok: false,
          error: r.error,
          transitionIds,
          paymentUri: uri,
          intentId: enq.intent.id,
        };
      }
      await sleep(40);
    }

    const rootsMatch = rep.lab.stateRoot === seq.lab.stateRoot;
    return {
      ok: rootsMatch && proved.length > 0,
      paymentUri: uri,
      intentId: enq.intent.id,
      transitionIds,
      sequencerRoot: seq.lab.stateRoot,
      replicaRoot: rep.lab.stateRoot,
      rootsMatch,
      error: rootsMatch ? undefined : "ROOT_MISMATCH",
    };
  } finally {
    await seq.stop();
    await rep.stop();
  }
}
