import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDigestAggregate,
  computeAggregateDigest,
  canonicalAggregateBytes,
  verifyAggregateIntegrity,
  verifyAggregateContext,
  validateAggregateEntries,
  aggregateProposalPayload,
  isDigestOnlyAggregatePayload,
  toConsensusInput,
} from "./uep36-digest-agg.ts";
import {
  parallelSafeScheduleApply,
  fullStateRootsEqual,
} from "./uep36-parallel-exec.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { MultiLeaderLab } from "./uep36-multi-leader.ts";
import { ProcessCluster } from "./uep35-process-cluster.ts";

describe("UEP-36.1.1 digest/parallel hardening", () => {
  // ---- canonical encoding ----
  it("delimiter ambiguity: a|b + c  ≠  a + b|c", () => {
    const A = canonicalAggregateBytes(0, 1, "GENESIS", [
      { batchId: "a|b", txDigest: "c" },
    ]);
    const B = canonicalAggregateBytes(0, 1, "GENESIS", [
      { batchId: "a", txDigest: "b|c" },
    ]);
    assert.notEqual(A.toString("hex"), B.toString("hex"));
    assert.notEqual(
      computeAggregateDigest(0, 1, "GENESIS", [{ batchId: "a|b", txDigest: "c" }]),
      computeAggregateDigest(0, 1, "GENESIS", [{ batchId: "a", txDigest: "b|c" }]),
    );
  });

  it("Unicode and empty-field rejection", () => {
    const u1 = computeAggregateDigest(0, 1, "GENESIS", [
      { batchId: "café", txDigest: "d1" },
    ]);
    const u2 = computeAggregateDigest(0, 1, "GENESIS", [
      { batchId: "cafe", txDigest: "d1" },
    ]);
    assert.notEqual(u1, u2);
    assert.equal(validateAggregateEntries([{ batchId: "", txDigest: "x" }]).ok, false);
    assert.equal(validateAggregateEntries([{ batchId: "x", txDigest: "" }]).ok, false);
  });

  it("long strings produce stable distinct digests", () => {
    const longA = "x".repeat(10_000);
    const longB = "y".repeat(10_000);
    const dA = computeAggregateDigest(0, 1, "GENESIS", [
      { batchId: longA, txDigest: "t" },
    ]);
    const dB = computeAggregateDigest(0, 1, "GENESIS", [
      { batchId: longB, txDigest: "t" },
    ]);
    assert.notEqual(dA, dB);
    assert.equal(dA.length, 64);
  });

  // ---- integrity / tamper ----
  it("reorder entries does NOT change aggregateDigest (canonical by batchId)", () => {
    const a = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
      { batchId: "b2", txDigest: "d2" },
    ]);
    const b = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b2", txDigest: "d2" },
      { batchId: "b1", txDigest: "d1" },
    ]);
    assert.equal(a.aggregateDigest, b.aggregateDigest);
    assert.equal(verifyAggregateIntegrity(a), true);
  });

  it("tamper batchId / txDigest / epoch / height / prevRoot", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    assert.equal(
      verifyAggregateIntegrity({
        ...agg,
        entries: [{ batchId: "EVIL", txDigest: "d1" }],
      }),
      false,
    );
    assert.equal(
      verifyAggregateIntegrity({
        ...agg,
        entries: [{ batchId: "b1", txDigest: "EVIL" }],
      }),
      false,
    );
    assert.equal(verifyAggregateIntegrity({ ...agg, epoch: 9 }), false);
    assert.equal(verifyAggregateIntegrity({ ...agg, height: 99 }), false);
    assert.equal(
      verifyAggregateIntegrity({ ...agg, previousStateRoot: "OTHER" }),
      false,
    );
  });

  it("duplicate batchId rejected at build", () => {
    assert.throws(() =>
      buildDigestAggregate(0, 1, "GENESIS", [
        { batchId: "same", txDigest: "d1" },
        { batchId: "same", txDigest: "d2" },
      ]),
    );
  });

  it("empty entries rejected", () => {
    assert.throws(() => buildDigestAggregate(0, 1, "GENESIS", []));
  });

  it("forged aggregateDigest fails integrity", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    assert.equal(
      verifyAggregateIntegrity({ ...agg, aggregateDigest: "00".repeat(32) }),
      false,
    );
  });

  // ---- context binding ----
  it("aggregate cannot be reused at wrong epoch/height/prevRoot", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    assert.equal(verifyAggregateContext(agg, 0, 1, "GENESIS").ok, true);
    assert.equal(verifyAggregateContext(agg, 0, 2, "GENESIS").ok, false);
    assert.equal(verifyAggregateContext(agg, 1, 1, "GENESIS").ok, false);
    assert.equal(verifyAggregateContext(agg, 0, 1, "ROOT2").ok, false);
  });

  it("proposal payload has no txs and no execution stateRoot", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    const json = JSON.stringify(aggregateProposalPayload(agg));
    assert.equal(isDigestOnlyAggregatePayload(json), true);
    assert.equal(json.includes('"txs"'), false);
  });

  it("toConsensusInput is not a finality certificate", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b1", txDigest: "d1" },
    ]);
    const input = toConsensusInput(agg);
    assert.equal(input.proposalPayload.kind, "DIGEST_AGGREGATE");
    assert.ok(!("finality" in input));
    assert.ok(!("commitCert" in input));
  });

  // ---- full state equivalence ----
  it("parallel-safe schedule: full stateRoot match", () => {
    const initial = new LocalEconomicState({
      s0: 1000n,
      s1: 1000n,
      s2: 1000n,
      r0: 0n,
      r1: 0n,
      r2: 0n,
      r3: 0n,
    });
    const txs: BatchTx[] = [
      { id: "a", from: "s0", to: "r0", amount: 1n },
      { id: "b", from: "s1", to: "r1", amount: 2n },
      { id: "c", from: "s2", to: "r2", amount: 3n },
    ];
    const r = parallelSafeScheduleApply(initial, txs);
    assert.equal(r.rootsMatch, true);
    assert.equal(r.sequentialRoot, r.scheduledRoot);
  });

  it("adversarial: divergence on r2 is detected via stateRoot", () => {
    const a = new LocalEconomicState({ s0: 100n, r2: 0n });
    const b = a.clone();
    a.applyBatch([{ id: "t", from: "s0", to: "r2", amount: 1n }]);
    // b diverges: different amount to r2
    b.applyBatch([{ id: "t", from: "s0", to: "r2", amount: 2n }]);
    assert.equal(fullStateRootsEqual(a, b), false);
    // s0 alone would not be enough if we only checked s0 after fee — roots must differ
    assert.notEqual(a.stateRoot(), b.stateRoot());
  });

  // ---- reproducibility ----
  it("parallelAvailabilityRound is deterministic under same seed", () => {
    const lab1 = new MultiLeaderLab(4, 42, 2);
    const lab2 = new MultiLeaderLab(4, 42, 2);
    const a = lab1.parallelAvailabilityRound(1);
    const b = lab2.parallelAvailabilityRound(1);
    assert.deepEqual(a.batchIds, b.batchIds);
    assert.equal(a.headersSeenByAllHonest, true);
    assert.equal(b.headersSeenByAllHonest, true);
  });

  it("different seeds produce different availability batch ids", () => {
    const a = new MultiLeaderLab(4, 1, 2).parallelAvailabilityRound(1);
    const b = new MultiLeaderLab(4, 2, 2).parallelAvailabilityRound(1);
    assert.notDeepEqual(a.batchIds, b.batchIds);
  });

  // ---- process multi-leader 3 heights ----
  it("process path: mn-0, mn-1, mn-2 → three heights, same root", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      const leaders = ["mn-0", "mn-1", "mn-2"] as const;
      for (let h = 0; h < 3; h++) {
        await cluster.propose(leaders[h]!, [
          {
            id: `h${h}-tx`,
            from: `s${h % 3}`,
            to: `r${h % 4}`,
            amount: "1",
          },
        ]);
        let ok = false;
        for (let i = 0; i < 50; i++) {
          const st = await cluster.pollStatus();
          if (
            st.every((s) => s.finalized.length >= h + 1) &&
            new Set(st.map((s) => s.stateRoot)).size === 1
          ) {
            ok = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(ok, true, `height ${h + 1} must finalize on all nodes`);
      }
    } finally {
      await cluster.stop();
    }
  });
});
