/**
 * UEP-33.1 — ZK payment on 3-node cluster (all replicas Groth16-verify).
 */

import { Fr } from "../core/field.ts";
import { ExecutionEngine } from "./execution-engine.ts";
import {
  createPaymentRequest,
  encodePaymentRequestUri,
  type MerchantMacKey,
} from "./payment-request.ts";
import { enqueueFromPaymentUri } from "./payment-to-intent.ts";
import { DomainCodeName } from "./address-v2.ts";
import { assertEngineProofPolicy, type NetworkProfile } from "./network-profile.ts";
import { bootUep33Cluster, rootsEqual, type ClusterHandles } from "./uep33-cluster.ts";
import { sleep } from "./node-auth-transport.ts";

export type Uep33ZkResult = {
  ok: boolean;
  error?: string;
  transitionIds: string[];
  roots: { seq: string; r1: string; r2: string };
  sequences: { seq: number; r1: number; r2: number };
  paymentUri?: string;
};

/**
 * Full path:
 * Payment → Engine Groth16 → pin VK → 3-node cluster → envelopes →
 * both replicas zkVerify → same root
 */
export async function runUep33ZkPaymentCluster(opts?: {
  amount?: bigint;
  profile?: NetworkProfile;
  listenHost?: string;
}): Promise<Uep33ZkResult> {
  const amount = opts?.amount ?? 1500n;
  const profile = opts?.profile ?? "DEV-ZK";
  assertEngineProofPolicy(profile, true);

  const eng = new ExecutionEngine({
    depth: 4,
    profile: "local",
    requireProof: true,
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
    kid: "uep33-shop",
    key: "uep33-merchant-secret-key!32b",
  };
  const pr = createPaymentRequest({
    networkId: "local",
    domainCode: DomainCodeName.earth,
    addressId: Fr.from(222n),
    assetId: Fr.from(1n),
    amount,
    orderId: `uep33-${Date.now()}`,
    merchant,
  });
  const uri = encodePaymentRequestUri(pr);
  const enq = enqueueFromPaymentUri(eng, "alice", uri, merchant);
  if (!enq.ok) {
    return {
      ok: false,
      error: enq.error,
      transitionIds: [],
      roots: { seq: "", r1: "", r2: "" },
      sequences: { seq: 0, r1: 0, r2: 0 },
      paymentUri: uri,
    };
  }

  const round = await eng.runRound();
  if (round.proved.length === 0 || round.commits.filter((c) => c.ok).length === 0) {
    return {
      ok: false,
      error: round.failed[0]?.error ?? "NO_COMMIT",
      transitionIds: [],
      roots: { seq: "", r1: "", r2: "" },
      sequences: { seq: 0, r1: 0, r2: 0 },
      paymentUri: uri,
    };
  }

  const art = round.proved[0]!;
  if (!art.vkId || !art.vkHex || !art.proofHex || !art.publicInputsHex) {
    return {
      ok: false,
      error: "PROVER_INCOMPLETE_ARTIFACT",
      transitionIds: [art.transitionId],
      roots: { seq: "", r1: "", r2: "" },
      sequences: { seq: 0, r1: 0, r2: 0 },
      paymentUri: uri,
    };
  }

  let cluster: ClusterHandles | null = null;
  try {
    cluster = await bootUep33Cluster({
      networkId: "local",
      domainId: DomainCodeName.earth,
      requireZkVerify: true,
      listenHost: opts?.listenHost ?? "127.0.0.1",
      pinnedVk: { vkId: art.vkId, vkHex: art.vkHex },
    });

    // Seed canonical Fr roots from prover (no GENESIS labels on ZK path)
    const seedRoot = art.oldStateRoot;
    const seedNf =
      art.publicInputsHex?.[2] ??
      art.oldNullifierRoot ??
      art.newNullifierRoot;
    for (const n of [cluster.seq, cluster.r1, cluster.r2]) {
      n.lab.stateRoot = seedRoot;
      if (seedNf) n.lab.nullifierRoot = seedNf;
    }

    const transitionIds: string[] = [];
    for (const job of round.proved) {
      transitionIds.push(job.transitionId);
      const r = cluster.seq.commitAndBroadcast({
        previousStateRoot: cluster.seq.lab.stateRoot,
        newStateRoot: job.newStateRoot,
        transitionId: job.transitionId,
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
          roots: {
            seq: cluster.seq.lab.stateRoot,
            r1: cluster.r1.lab.stateRoot,
            r2: cluster.r2.lab.stateRoot,
          },
          sequences: {
            seq: cluster.seq.lab.sequence,
            r1: cluster.r1.lab.sequence,
            r2: cluster.r2.lab.sequence,
          },
          paymentUri: uri,
        };
      }
      await sleep(60);
    }

    const ok = rootsEqual(cluster.seq, cluster.r1, cluster.r2);
    return {
      ok,
      error: ok ? undefined : "ROOT_MISMATCH_ACROSS_CLUSTER",
      transitionIds,
      roots: {
        seq: cluster.seq.lab.stateRoot,
        r1: cluster.r1.lab.stateRoot,
        r2: cluster.r2.lab.stateRoot,
      },
      sequences: {
        seq: cluster.seq.lab.sequence,
        r1: cluster.r1.lab.sequence,
        r2: cluster.r2.lab.sequence,
      },
      paymentUri: uri,
    };
  } finally {
    await cluster?.stop();
  }
}
