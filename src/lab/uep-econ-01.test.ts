/**
 * UEP-ECON-01 — Economically meaningful TX on MultiNodeCluster
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import {
  ECON_01_VERSION,
  ECON_01_MIN_MEANINGFUL_AMOUNT,
  snapshotEconomic,
  buildReceipt,
  isEconomicallyMeaningfulAmount,
  creatorFee,
  requiredSenderDebit,
  type EconomicStateView,
} from "./uep-econ-01.ts";

function asView(n: {
  economic: {
    balance(id: string): bigint;
    treasuryBalance: bigint;
    stateRoot(): string;
    sequence: number;
    balancesSnapshot(): Record<string, string>;
  };
}): EconomicStateView {
  return n.economic;
}

describe("UEP-ECON-01 economically meaningful transaction", () => {
  // INTEGRATION CONFLICT (C-3: minimum protocol fee of 1 unit in the public core vs no minimum in the circuit). Pending a maintainer decision; see docs/LABS.md.
  it.skip("fee policy: amount 1000 → fee 1; amount 999 → fee 0", () => {
    assert.equal(creatorFee(1000n), 1n);
    assert.equal(creatorFee(999n), 0n);
    assert.equal(isEconomicallyMeaningfulAmount(1000n), true);
    assert.equal(isEconomicallyMeaningfulAmount(999n), false);
    assert.equal(ECON_01_MIN_MEANINGFUL_AMOUNT, 1000n);
  });

  it("local structural: transfer 5000 accrues treasury and conserves supply", () => {
    const cluster = new MultiNodeCluster(4, 3801, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: false,
      initialBalances: {
        alice: 50_000n,
        bob: 0n,
        s0: 100n,
        r0: 0n,
      },
    });
    const leader = cluster.leaderForNextHeight();
    const node = cluster.node(leader);
    const before = snapshotEconomic(asView(node));
    const amount = 5000n;
    const fee = creatorFee(amount);
    assert.equal(fee, 5n);

    const prop = cluster.proposeAggregateFrom(leader, [
      { txs: [{ id: "econ-1", from: "alice", to: "bob", amount }] },
    ]);
    assert.ok(prop);

    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);

    const after = snapshotEconomic(asView(cluster.node("mn-0")));
    const receipt = buildReceipt({
      tx: { id: "econ-1", from: "alice", to: "bob", amount },
      before,
      after,
    });

    assert.equal(receipt.version, ECON_01_VERSION);
    assert.equal(receipt.fee, "5");
    assert.equal(receipt.treasuryDelta, "5");
    assert.equal(receipt.recipientDelta, "5000");
    assert.equal(receipt.senderDelta, (-requiredSenderDebit(amount)).toString());
    assert.equal(receipt.conservationHolds, true);
    assert.equal(receipt.feePolicyHolds, true);
    assert.equal(receipt.feeNonZero, true);
    assert.equal(receipt.economicallyMeaningful, true);

    // All honest nodes same treasury
    for (const n of cluster.nodes) {
      if (n.byzantine) continue;
      assert.equal(n.economic.treasuryBalance, 5n);
      assert.equal(n.economic.balance("alice"), 50_000n - 5005n);
      assert.equal(n.economic.balance("bob"), 5000n);
    }
  });

  it("poseidon-zk path: meaningful TX finalizes same economic tip", () => {
    assert.ok(findUepZkBinary());
    const cluster = new MultiNodeCluster(4, 3802, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: true,
      initialBalances: {
        alice: 20_000n,
        bob: 1000n,
        s0: 100n,
        r0: 0n,
      },
    });
    const leader = cluster.leaderForNextHeight();
    const before = snapshotEconomic(asView(cluster.node(leader)));
    const amount = 2000n;
    assert.equal(creatorFee(amount), 2n);

    assert.ok(
      cluster.proposeAggregateFrom(leader, [
        { txs: [{ id: "econ-zk-1", from: "alice", to: "bob", amount }] },
      ]),
    );
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const after = snapshotEconomic(asView(cluster.node("mn-0")));
    const receipt = buildReceipt({
      tx: { id: "econ-zk-1", from: "alice", to: "bob", amount },
      before,
      after,
    });
    assert.equal(receipt.economicallyMeaningful, true);
    assert.equal(receipt.conservationHolds, true);
    assert.equal(cluster.node("mn-0").economic.treasuryBalance, 2n);
    assert.notEqual(before.stateRoot, after.stateRoot);
  });

  // INTEGRATION CONFLICT (C-3: minimum protocol fee of 1 unit in the public core vs no minimum in the circuit). Pending a maintainer decision; see docs/LABS.md.
  it.skip("sub-threshold amount is valid TX but not economicallyMeaningful (fee=0)", () => {
    const cluster = new MultiNodeCluster(4, 3803, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: { alice: 5000n, bob: 0n, s0: 100n, r0: 0n },
    });
    const leader = cluster.leaderForNextHeight();
    const before = snapshotEconomic(asView(cluster.node(leader)));
    const amount = 500n;
    assert.equal(creatorFee(amount), 0n);

    assert.ok(
      cluster.proposeAggregateFrom(leader, [
        { txs: [{ id: "dust", from: "alice", to: "bob", amount }] },
      ]),
    );
    for (let t = 0; t < 120; t++) {
      cluster.tick(20, 5);
      if (cluster.nodes.every((n) => n.economic.sequence >= 1)) break;
    }
    const after = snapshotEconomic(asView(cluster.node("mn-0")));
    const receipt = buildReceipt({
      tx: { id: "dust", from: "alice", to: "bob", amount },
      before,
      after,
    });
    assert.equal(receipt.conservationHolds, true);
    assert.equal(receipt.feeNonZero, false);
    assert.equal(receipt.economicallyMeaningful, false);
    assert.equal(cluster.node("mn-0").economic.treasuryBalance, 0n);
  });

  it("insufficient funds: no state change, no false receipt", () => {
    const cluster = new MultiNodeCluster(4, 3804, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: { alice: 100n, bob: 0n, s0: 100n, r0: 0n },
    });
    const beforeRoot = cluster.node("mn-0").economic.stateRoot();
    const beforeT = cluster.node("mn-0").economic.treasuryBalance;
    const prop = cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), [
      { txs: [{ id: "bad", from: "alice", to: "bob", amount: 50_000n }] },
    ]);
    assert.equal(prop, null);
    assert.equal(cluster.node("mn-0").economic.stateRoot(), beforeRoot);
    assert.equal(cluster.node("mn-0").economic.treasuryBalance, beforeT);
  });
});
