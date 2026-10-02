/**
 * UEP-36.3 — DigestAggregate → CommitCert → Finality → certified execution (LAB).
 *
 * DigestAggregate is INPUT to consensus, not finality by itself.
 * Does NOT modify Poseidon/ZK/fee/BFT thresholds.
 */

import { createHash } from "node:crypto";
import {
  buildDigestAggregate,
  aggregateProposalPayload,
  verifyAggregateIntegrity,
  verifyAggregateContext,
  type DigestAggregate,
  type BatchDigestEntry,
} from "./uep36-digest-agg.ts";
import {
  parallelSafeScheduleApply,
  type ParallelSafeScheduleResult,
} from "./uep36-parallel-exec.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  createNodeIdentity,
  type NodeIdentity,
} from "./node-identity.ts";
import {
  signCommitVote,
  assembleCommitCert,
  verifyCommitCert,
  ProposalBoard,
  type TransitionProposal,
  type CommitCert,
  type CommitVote,
} from "./uep34-commit-cert.ts";
import {
  buildFinalityCertificate,
  type FinalityCertificate,
} from "./uep35-finality.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";

export type AggregateBatch = {
  batchId: string;
  txs: BatchTx[];
};

export type AggregateConsensusConfig = {
  networkId?: string;
  domainId?: number;
  epoch?: number;
  n?: number;
};

export type AggregatePipelineResult = {
  aggregate: DigestAggregate;
  execution: ParallelSafeScheduleResult;
  proposal: TransitionProposal;
  commitCert: CommitCert;
  finalityCert: FinalityCertificate;
  previousStateRoot: string;
  newStateRoot: string;
  applied: boolean;
  certVerified: boolean;
};

function entriesFromBatches(batches: AggregateBatch[]): BatchDigestEntry[] {
  return batches.map((b) => ({
    batchId: b.batchId,
    txDigest: createHash("sha256")
      .update(
        b.txs
          .map((t) => `${t.id}:${t.from}:${t.to}:${t.amount.toString()}`)
          .join(";"),
      )
      .digest("hex"),
  }));
}

function flattenTxs(batches: AggregateBatch[]): BatchTx[] {
  const out: BatchTx[] = [];
  for (const b of batches) out.push(...b.txs);
  return out;
}

export function aggregateTransitionDigest(
  agg: DigestAggregate,
  previousStateRoot: string,
  newStateRoot: string,
  networkId: string,
  domainId: number,
  leaderNodeId: string,
): string {
  const payload = aggregateProposalPayload(agg);
  const material = [
    "UEP-36.3-AGG-PROP",
    networkId,
    String(domainId),
    leaderNodeId,
    String(agg.epoch),
    String(agg.height),
    previousStateRoot,
    newStateRoot,
    agg.aggregateDigest,
    JSON.stringify(payload),
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

export class AggregateConsensusLab {
  readonly networkId: string;
  readonly domainId: number;
  readonly epoch: number;
  readonly identities: NodeIdentity[];
  readonly candidateIds: string[];
  readonly board = new ProposalBoard();
  readonly n: number;
  readonly quorum: number;

  constructor(cfg: AggregateConsensusConfig = {}) {
    this.networkId = cfg.networkId ?? "uep-lab";
    this.domainId = cfg.domainId ?? 0;
    this.epoch = cfg.epoch ?? 0;
    this.n = cfg.n ?? 4;
    const gate = assertBftConfig(this.n, "BFT-CLASSIC");
    if (!gate.ok) throw new Error(gate.reason);
    this.quorum = gate.params.quorum;
    this.identities = [];
    this.candidateIds = [];
    for (let i = 0; i < this.n; i++) {
      const id = createNodeIdentity(`agg-n${i}`);
      this.identities.push(id);
      this.candidateIds.push(id.nodeId);
    }
  }

  publicKeyOf = (nodeId: string): string | undefined => {
    return this.identities.find((i) => i.nodeId === nodeId)?.publicKeyHex;
  };

  run(
    initial: LocalEconomicState,
    batches: AggregateBatch[],
    opts?: { leaderIndex?: number; applyTo?: LocalEconomicState },
  ): AggregatePipelineResult {
    if (batches.length === 0) throw new Error("EMPTY_BATCHES");
    const leader = this.identities[opts?.leaderIndex ?? 0]!;
    const previousStateRoot = initial.stateRoot();
    const height = initial.sequence + 1;

    const entries = entriesFromBatches(batches);
    const aggregate = buildDigestAggregate(
      this.epoch,
      height,
      previousStateRoot,
      entries,
    );
    if (!verifyAggregateIntegrity(aggregate)) {
      throw new Error("AGGREGATE_INTEGRITY");
    }
    const ctx = verifyAggregateContext(
      aggregate,
      this.epoch,
      height,
      previousStateRoot,
    );
    if (!ctx.ok) throw new Error(ctx.reason);

    const txs = flattenTxs(batches);
    const execution = parallelSafeScheduleApply(initial, txs);
    if (!execution.fullStateEqual || !execution.rootsMatch) {
      throw new Error("EXECUTION_DIVERGENCE");
    }
    const newStateRoot = execution.scheduledRoot;

    const digest = aggregateTransitionDigest(
      aggregate,
      previousStateRoot,
      newStateRoot,
      this.networkId,
      this.domainId,
      leader.nodeId,
    );

    const proposal: TransitionProposal = {
      digest,
      networkId: this.networkId,
      domainId: this.domainId,
      leaderNodeId: leader.nodeId,
      sequence: height,
      previousStateRoot,
      newStateRoot,
      nullifier: `AGG|${aggregate.aggregateDigest}`,
      transitionId: aggregate.aggregateDigest,
    };

    const reg = this.board.register(proposal);
    if (!reg.ok) throw new Error(reg.reason);

    const votes: CommitVote[] = this.identities.map((id) =>
      signCommitVote(id, digest),
    );
    const commitCert = assembleCommitCert(proposal, votes);
    const vr = verifyCommitCert(
      commitCert,
      this.candidateIds,
      this.publicKeyOf,
      this.board,
      { bftProfile: "BFT-CLASSIC" },
    );
    if (!vr.ok) throw new Error(vr.reason);

    const finalityCert = buildFinalityCertificate(proposal, commitCert, {
      networkId: this.networkId,
      domainId: this.domainId,
      epoch: this.epoch,
      finalizers: this.identities,
    });

    let applied = false;
    const target = opts?.applyTo;
    if (target) {
      if (target.stateRoot() !== previousStateRoot) {
        throw new Error("APPLY_PREV_ROOT_MISMATCH");
      }
      // Re-verify before apply (certified execution gate)
      const again = verifyCommitCert(
        commitCert,
        this.candidateIds,
        this.publicKeyOf,
        undefined,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!again.ok) throw new Error(`APPLY_BLOCKED:${again.reason}`);

      for (const wave of execution.waves) {
        if (wave.length === 0) continue;
        const r = target.applyTransfers(wave);
        if (!r.ok) throw new Error(r.reason);
      }
      const root = target.commitLogicalHeight();
      if (root !== newStateRoot) throw new Error("APPLY_ROOT_MISMATCH");
      for (const b of batches) target.markFinalized(b.batchId);
      applied = true;
    }

    return {
      aggregate,
      execution,
      proposal,
      commitCert,
      finalityCert,
      previousStateRoot,
      newStateRoot,
      applied,
      certVerified: true,
    };
  }
}
