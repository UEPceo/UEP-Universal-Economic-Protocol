import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HeightVoteLock,
  ProposalTracker,
  validateProposalSemantics,
  previousRootMatches,
  assertAggregateDigestBinding,
  AGGREGATE_SEMANTICS_VERSION,
} from "./uep36-aggregate-semantics.ts";
import { proposalDigestFromPayload, type ProposalPayload } from "./uep35-consensus-msg.ts";
import { buildDigestAggregate } from "./uep36-digest-agg.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";

function baseAggPayload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  const entries = [
    { batchId: "b1", txDigest: "aa".repeat(32) },
    { batchId: "b2", txDigest: "bb".repeat(32) },
  ];
  const agg = buildDigestAggregate(0, 1, "GENESIS", entries);
  return {
    batchId: "b1",
    txDigest: agg.aggregateDigest,
    stateRoot: "cc".repeat(32),
    epoch: 0,
    height: 1,
    previousStateRoot: "GENESIS",
    aggregateDigest: agg.aggregateDigest,
    batchIds: ["b1", "b2"],
    entryDigests: entries,
    ...over,
  };
}

describe("UEP-36.7 aggregate semantics closure", () => {
  it("semantics version pinned", () => {
    assert.equal(AGGREGATE_SEMANTICS_VERSION, "36.10");
  });

  it("rejects incomplete aggregate payload", () => {
    assert.equal(
      validateProposalSemantics(
        baseAggPayload({ aggregateDigest: undefined, batchIds: ["b1"] }),
      ).ok,
      false,
    );
    assert.equal(
      validateProposalSemantics(baseAggPayload({ batchIds: [] })).ok,
      false,
    );
    assert.equal(
      validateProposalSemantics(baseAggPayload({ batchId: "orphan" })).ok,
      false,
    );
    assert.equal(
      validateProposalSemantics(baseAggPayload({ height: 0 })).ok,
      false,
    );
  });

  it("accepts well-formed aggregate payload", () => {
    assert.equal(validateProposalSemantics(baseAggPayload()).ok, true);
  });

  it("proposalDigest deterministic for aggregates", () => {
    const p = baseAggPayload();
    assert.equal(assertAggregateDigestBinding(p).ok, true);
    assert.equal(proposalDigestFromPayload(p), proposalDigestFromPayload({ ...p }));
  });

  it("HeightVoteLock: first wins, second different digest conflicts", () => {
    const lock = new HeightVoteLock();
    assert.equal(lock.tryLock(0, 1, "d1").ok, true);
    assert.equal(lock.tryLock(0, 1, "d1").ok, true); // idempotent
    assert.equal(lock.tryLock(0, 1, "d2").ok, false);
    assert.equal(lock.hasEvidence(), true);
    assert.equal(lock.tryLock(0, 2, "d3").ok, true); // new height
  });

  it("ProposalTracker detects leader equivocation", () => {
    const tr = new ProposalTracker();
    assert.equal(tr.observe("L", 0, 1, "A").equivocation, false);
    assert.equal(tr.observe("L", 0, 1, "B").equivocation, true);
  });

  it("previousRootMatches enforces chain binding", () => {
    assert.equal(previousRootMatches("R0", "R0").ok, true);
    assert.equal(previousRootMatches("R0", "R1").ok, false);
  });

  it("sequential ≡ scheduled still holds (regression)", () => {
    const eco = new LocalEconomicState({
      s0: 1000n,
      s1: 1000n,
      r0: 0n,
      r1: 0n,
    });
    const txs = [
      { id: "t1", from: "s0", to: "r0", amount: 1n },
      { id: "t2", from: "s1", to: "r1", amount: 1n },
    ];
    const r = parallelSafeScheduleApply(eco, txs);
    assert.equal(r.fullStateEqual, true);
    assert.equal(r.sequentialRoot, r.scheduledRoot);
  });

  it("multi-node: leader aggregate equivocation → no conflicting finality", () => {
    const cluster = new MultiNodeCluster(4, 3670);
    const eq = cluster.proposeAggregateEquivocation("mn-0", [
      { txs: [{ id: "e1", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "e2", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(eq);
    assert.notEqual(eq!.digestA, eq!.digestB);
    for (let i = 0; i < 80; i++) cluster.tick(20, 5);

    const honest = cluster.nodes.filter((n) => !n.byzantine);
    // At most one digest may be locked per height across honest nodes
    const locks = new Set(
      honest.map((n) => n.voteLock.get(0, eq!.height)).filter(Boolean),
    );
    assert.ok(locks.size <= 1, "honest locks must not disagree on two digests");

    // Evidence of conflict observed on peers that saw both
    const anyEvidence = honest.some((n) => n.voteLock.hasEvidence());
    // Not all peers see both (split), but if a peer saw both it has evidence
    // Peers that only saw one may lock that one — finality still requires quorum of 3
    // With 3 peers split 2/1 on digests, neither reaches quorum of 3 votes on same digest
    const seqs = honest.map((n) => n.economic.sequence);
    assert.ok(
      seqs.every((s) => s === 0) || new Set(honest.map((n) => n.economic.stateRoot())).size === 1,
      "must not have two different finalized roots",
    );
    // Stronger: no finality at all under pure split equivocation with n=4
    assert.ok(
      seqs.every((s) => s === 0),
      "split equivocation should prevent BFT finality",
    );
  });

  it("multi-node: honest aggregate still finalizes after semantics", () => {
    const cluster = new MultiNodeCluster(4, 3671);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "ok1", from: "s0", to: "r0", amount: 2n }] },
      { txs: [{ id: "ok2", from: "s1", to: "r1", amount: 2n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 60; i++) cluster.tick(20, 5);
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const honest = cluster.nodes.filter((n) => !n.byzantine);
    assert.ok(honest.every((n) => n.economic.sequence >= 1));
    // Vote locks agree
    const digests = new Set(
      honest.map((n) => n.voteLock.get(0, 1)).filter(Boolean),
    );
    assert.equal(digests.size, 1);
  });

  it("changing stateRoot changes proposalDigest (tamper)", () => {
    const a = baseAggPayload();
    const b = baseAggPayload({ stateRoot: "dd".repeat(32) });
    assert.notEqual(proposalDigestFromPayload(a), proposalDigestFromPayload(b));
  });

  it("changing previousStateRoot changes proposalDigest", () => {
    const a = baseAggPayload();
    const b = baseAggPayload({ previousStateRoot: "OTHER" });
    assert.notEqual(proposalDigestFromPayload(a), proposalDigestFromPayload(b));
  });

  it("duplicate batchIds rejected", () => {
    const p = baseAggPayload({ batchIds: ["b1", "b1"] });
    assert.equal(validateProposalSemantics(p).ok, false);
  });
});
