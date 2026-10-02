/**
 * UEP-36.10 — Aggregate contract freeze + regression probes
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGGREGATE_SEMANTICS_VERSION,
  validateProposalSemantics,
  HeightVoteLock,
} from "./uep36-aggregate-semantics.ts";
import {
  proposalDigestFromPayload,
  type ProposalPayload,
} from "./uep35-consensus-msg.ts";
import {
  buildDigestAggregate,
  computeAggregateDigest,
  canonicalizeEntries,
} from "./uep36-digest-agg.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";

/** FROZEN domain tags — changing these is a breaking protocol change */
const FROZEN = {
  semanticsVersion: "36.10",
  proposalDomain: "UEP-36.4-AGG-PROP",
  aggregateEncodePrefix: "UEP36.1.1AGG",
  digestAggObjectVersion: "36.1.1",
} as const;

function samplePayload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  const entries = [
    { batchId: "z-batch", txDigest: "11".repeat(32) },
    { batchId: "a-batch", txDigest: "22".repeat(32) },
  ];
  const agg = buildDigestAggregate(0, 1, "GENESIS", entries);
  const batchIds = entries.map((e) => e.batchId).sort();
  return {
    batchId: batchIds[0]!,
    txDigest: agg.aggregateDigest,
    stateRoot: "33".repeat(32),
    epoch: 0,
    height: 1,
    previousStateRoot: "GENESIS",
    aggregateDigest: agg.aggregateDigest,
    batchIds,
    entryDigests: canonicalizeEntries(entries),
    ...over,
  };
}

describe("UEP-36.10 aggregate contract freeze", () => {
  it("semantics version frozen at 36.10", () => {
    assert.equal(AGGREGATE_SEMANTICS_VERSION, FROZEN.semanticsVersion);
  });

  it("digest object version frozen at 36.1.1", () => {
    const agg = buildDigestAggregate(0, 1, "GENESIS", [
      { batchId: "b", txDigest: "aa".repeat(32) },
    ]);
    assert.equal(agg.version, FROZEN.digestAggObjectVersion);
  });

  it("batchIds order does not change proposalDigest (set canonicity)", () => {
    const entries = [
      { batchId: "b2", txDigest: "aa".repeat(32) },
      { batchId: "b1", txDigest: "bb".repeat(32) },
    ];
    const agg = buildDigestAggregate(0, 1, "GENESIS", entries);
    const p1: ProposalPayload = {
      batchId: "b1",
      txDigest: agg.aggregateDigest,
      stateRoot: "cc".repeat(32),
      epoch: 0,
      height: 1,
      previousStateRoot: "GENESIS",
      aggregateDigest: agg.aggregateDigest,
      batchIds: ["b1", "b2"],
      entryDigests: canonicalizeEntries(entries),
    };
    const p2 = { ...p1, batchIds: ["b2", "b1"] };
    assert.equal(proposalDigestFromPayload(p1), proposalDigestFromPayload(p2));
  });

  it("tampered aggregateDigest with entryDigests fails validation", () => {
    const p = samplePayload({ aggregateDigest: "ff".repeat(32) });
    const r = validateProposalSemantics(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /AGGREGATE_DIGEST_MISMATCH/);
  });

  it("well-formed aggregate with matching digest passes", () => {
    assert.equal(validateProposalSemantics(samplePayload()).ok, true);
  });

  it("aggregate entries are order-independent for aggregateDigest", () => {
    const e1 = [
      { batchId: "x", txDigest: "aa".repeat(32) },
      { batchId: "y", txDigest: "bb".repeat(32) },
    ];
    const e2 = [
      { batchId: "y", txDigest: "bb".repeat(32) },
      { batchId: "x", txDigest: "aa".repeat(32) },
    ];
    const a = buildDigestAggregate(0, 3, "ROOT", e1);
    const b = buildDigestAggregate(0, 3, "ROOT", e2);
    assert.equal(a.aggregateDigest, b.aggregateDigest);
  });

  it("end-to-end: multi-node aggregate still finalizes after freeze fixes", () => {
    const cluster = new MultiNodeCluster(4, 36100);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "fz-1", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "fz-2", from: "s1", to: "r1", amount: 1n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 60; i++) {
      cluster.tick(20, 5);
      if (cluster.allHonestSameStateRoot()) {
        const honest = cluster.nodes.filter((n) => !n.byzantine);
        if (honest.every((n) => n.economic.sequence >= 1)) break;
      }
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const honest = cluster.nodes.filter((n) => !n.byzantine);
    assert.ok(honest.every((n) => n.economic.sequence >= 1));
    // both batches marked finalized when batchIds present
    for (const n of honest) {
      for (const id of prop!.batchIds) {
        assert.equal(
          n.economic.isFinalized(id),
          true,
          `${n.id} missing finalize ${id}`,
        );
      }
    }
  });

  it("vote lock still exclusive per height after freeze", () => {
    const lock = new HeightVoteLock();
    assert.equal(lock.tryLock(0, 9, "D1").ok, true);
    assert.equal(lock.tryLock(0, 9, "D2").ok, false);
  });
});
