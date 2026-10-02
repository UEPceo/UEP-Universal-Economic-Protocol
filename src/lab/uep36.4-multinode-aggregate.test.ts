import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";

describe("UEP-36.4 multi-node DigestAggregate pipeline", () => {
  it("4 nodes: aggregate of 2 batches → same stateRoot on all honest", () => {
    const cluster = new MultiNodeCluster(4, 364);
    const prop = cluster.proposeAggregateFrom("mn-0", [
      {
        txs: [
          { id: "t1", from: "s0", to: "r0", amount: 10n },
          { id: "t2", from: "s1", to: "r1", amount: 5n },
        ],
      },
      {
        txs: [{ id: "t3", from: "s2", to: "r2", amount: 3n }],
      },
    ]);
    assert.ok(prop);
    assert.ok(prop!.aggregateDigest.length === 64);
    assert.equal(prop!.batchIds.length, 2);

    for (let i = 0; i < 80; i++) {
      cluster.tick(20, 5);
      const honest = cluster.nodes.filter((n) => !n.byzantine);
      const allApplied = honest.every((n) =>
        prop!.batchIds.every((id) => n.appliedBatches.has(id)),
      );
      if (cluster.allHonestSameStateRoot() && allApplied) break;
    }

    // Helper if minFinalizedBatches missing — use economic
    const honest = cluster.nodes.filter((n) => !n.byzantine);
    const roots = new Set(honest.map((n) => n.economic.stateRoot()));
    assert.equal(roots.size, 1, "all honest same stateRoot");
    assert.equal(honest[0]!.economic.stateRoot(), prop!.stateRoot);

    // All batch ids finalized on honest nodes
    for (const n of honest) {
      for (const id of prop!.batchIds) {
        assert.ok(
          n.economic.isFinalized(id) || n.appliedBatches.has(id),
          `${n.id} missing ${id}`,
        );
      }
    }
  });

  it("single-batch proposeFrom still works (regression)", () => {
    const cluster = new MultiNodeCluster(4, 365);
    const prop = cluster.proposeFrom("mn-0", [
      { id: "x", from: "s0", to: "r0", amount: 1n },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 60; i++) {
      cluster.tick(20, 5);
      if (cluster.allHonestSameStateRoot()) break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("aggregate proposal digest includes aggregateDigest field", () => {
    const cluster = new MultiNodeCluster(4, 366);
    const a = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "a", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "b", from: "s1", to: "r1", amount: 1n }] },
    ]);
    const b = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "c", from: "s0", to: "r0", amount: 1n }] },
      { txs: [{ id: "d", from: "s1", to: "r1", amount: 1n }] },
    ]);
    // Different heights / content → different digests
    assert.ok(a && b);
    assert.notEqual(a!.proposalDigest, b!.proposalDigest);
  });

  it("two sequential aggregates chain heights", () => {
    const cluster = new MultiNodeCluster(4, 367);
    const p1 = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "h1", from: "s0", to: "r0", amount: 1n }] },
    ]);
    assert.ok(p1);
    for (let i = 0; i < 60; i++) {
      cluster.tick(20, 5);
      if (
        cluster.nodes
          .filter((n) => !n.byzantine)
          .every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    const root1 = cluster.stateRoot("mn-0");
    const p2 = cluster.proposeAggregateFrom("mn-1", [
      { txs: [{ id: "h2", from: "s1", to: "r1", amount: 2n }] },
    ]);
    assert.ok(p2);
    for (let i = 0; i < 60; i++) {
      cluster.tick(20, 5);
      if (
        cluster.nodes
          .filter((n) => !n.byzantine)
          .every((n) => n.economic.sequence >= 2)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    assert.notEqual(cluster.stateRoot("mn-0"), root1);
  });
});
