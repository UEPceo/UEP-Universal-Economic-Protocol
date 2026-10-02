/**
 * UEP-ECON-03 — Escrow hold + service settlement
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  EscrowSettlementLab,
  EscrowBook,
  ECON_03_VERSION,
} from "./uep-econ-03.ts";
import { resultDigestFromPayload } from "./uep-econ-02.ts";
import {
  snapshotEconomic,
  buildReceipt,
  requiredSenderDebit,
  type EconomicStateView,
} from "./uep-econ-01.ts";

function view(n: { economic: EconomicStateView }): EconomicStateView {
  return n.economic;
}

describe("UEP-ECON-03 escrow settlement", () => {
  it("version", () => {
    assert.equal(ECON_03_VERSION, "ECON-03");
  });

  it("available balance decreases while held", () => {
    const book = new EscrowBook();
    const chain = {
      balance: (id: string) => (id === "c" ? 10_000n : 0n),
      treasuryBalance: 0n,
      stateRoot: () => "0".repeat(64),
      sequence: 0,
      balancesSnapshot: () => ({ c: "10000" }),
    };
    assert.equal(book.available("c", chain), 10_000n);
    const h = book.place({ obligationId: "o1", clientId: "c", price: 3000n });
    assert.ok(h.ok);
    if (!h.ok) return;
    assert.equal(h.value.amount, requiredSenderDebit(3000n));
    assert.equal(book.available("c", chain), 10_000n - requiredSenderDebit(3000n));
    assert.ok(book.release("o1").ok);
    assert.equal(book.available("c", chain), 10_000n);
  });

  it("acceptWithEscrow rejects when available insufficient", () => {
    const lab = new EscrowSettlementLab();
    const expected = resultDigestFromPayload("x");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "s",
      price: 9000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const chain = {
      balance: (id: string) => (id === "c" ? 5000n : 0n),
      treasuryBalance: 0n,
      stateRoot: () => "0".repeat(64),
      sequence: 0,
      balancesSnapshot: () => ({ c: "5000" }),
    };
    // need 9000+9 = 9009 > 5000
    const r = lab.acceptWithEscrow({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "1",
      chain,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /INSUFFICIENT_AVAILABLE/);
  });

  it("two obligations: second fails if first holds funds", () => {
    const lab = new EscrowSettlementLab();
    const expected = resultDigestFromPayload("y");
    const o1 = lab.registerOffer({
      providerId: "p",
      serviceKind: "a",
      price: 4000n,
      expectedResultDigest: expected,
    });
    const o2 = lab.registerOffer({
      providerId: "p",
      serviceKind: "b",
      price: 4000n,
      expectedResultDigest: expected,
    });
    assert.ok(o1.ok && o2.ok);
    if (!o1.ok || !o2.ok) return;
    const chain = {
      balance: (id: string) => (id === "c" ? 5000n : 0n),
      treasuryBalance: 0n,
      stateRoot: () => "0".repeat(64),
      sequence: 0,
      balancesSnapshot: () => ({ c: "5000" }),
    };
    // first needs 4004
    const a = lab.acceptWithEscrow({
      offerId: o1.value.offerId,
      clientId: "c",
      nonce: "n1",
      chain,
    });
    assert.ok(a.ok);
    // second needs another 4004 but only ~996 left available
    const b = lab.acceptWithEscrow({
      offerId: o2.value.offerId,
      clientId: "c",
      nonce: "n2",
      chain,
    });
    assert.equal(b.ok, false);
  });

  it("cancel OPEN releases hold", () => {
    const lab = new EscrowSettlementLab();
    const expected = resultDigestFromPayload("z");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "s",
      price: 2000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const chain = {
      balance: (id: string) => (id === "c" ? 10_000n : 0n),
      treasuryBalance: 0n,
      stateRoot: () => "0".repeat(64),
      sequence: 0,
      balancesSnapshot: () => ({ c: "10000" }),
    };
    const a = lab.acceptWithEscrow({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "c1",
      chain,
    });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.ok(lab.escrow.totalHeld("c") > 0n);
    const can = lab.cancelOpen(a.value.obligation.obligationId, "c");
    assert.ok(can.ok);
    assert.equal(lab.escrow.totalHeld("c"), 0n);
  });

  it("multinode: escrow → deliver → settle → meaningful receipt", () => {
    const lab = new EscrowSettlementLab();
    const expected = resultDigestFromPayload("job-9");
    const price = 5000n;
    const offer = lab.registerOffer({
      providerId: "provider",
      serviceKind: "compute",
      price,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;

    const cluster = new MultiNodeCluster(4, 3910, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: {
        client: 50_000n,
        provider: 0n,
        s0: 100n,
        r0: 0n,
      },
    });
    const chain = view(cluster.node("mn-0"));
    const acc = lab.acceptWithEscrow({
      offerId: offer.value.offerId,
      clientId: "client",
      nonce: "e1",
      chain,
    });
    assert.ok(acc.ok);
    if (!acc.ok) return;
    assert.equal(lab.escrow.holds.get(acc.value.obligation.obligationId)?.status, "HELD");

    assert.ok(
      lab.submitDelivery({
        obligationId: acc.value.obligation.obligationId,
        providerId: "provider",
        resultDigest: expected,
      }).ok,
    );
    const plan = lab.planSettlement(acc.value.obligation.obligationId);
    assert.ok(plan.ok);
    if (!plan.ok) return;

    const leader = cluster.leaderForNextHeight();
    const before = snapshotEconomic(view(cluster.node(leader)));
    assert.ok(cluster.proposeAggregateFrom(leader, [{ txs: [plan.value.tx] }]));
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const after = snapshotEconomic(view(cluster.node("mn-0")));
    const receipt = buildReceipt({ tx: plan.value.tx, before, after });
    assert.equal(receipt.economicallyMeaningful, true);
    assert.equal(receipt.conservationHolds, true);

    const done = lab.completeSettlement(
      acc.value.obligation.obligationId,
      plan.value.tx.id,
    );
    assert.ok(done.ok);
    assert.equal(
      lab.escrow.holds.get(acc.value.obligation.obligationId)?.status,
      "CONSUMED",
    );
  });

  it("digest mismatch: disputed then release unlocks client", () => {
    const lab = new EscrowSettlementLab();
    const expected = resultDigestFromPayload("good");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "s",
      price: 2000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const chain = {
      balance: (id: string) => (id === "c" ? 10_000n : 0n),
      treasuryBalance: 0n,
      stateRoot: () => "0".repeat(64),
      sequence: 0,
      balancesSnapshot: () => ({ c: "10000" }),
    };
    const acc = lab.acceptWithEscrow({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "d1",
      chain,
    });
    assert.ok(acc.ok);
    if (!acc.ok) return;
    lab.submitDelivery({
      obligationId: acc.value.obligation.obligationId,
      providerId: "p",
      resultDigest: resultDigestFromPayload("bad"),
    });
    assert.equal(lab.planSettlement(acc.value.obligation.obligationId).ok, false);
    assert.equal(
      lab.services.obligations.get(acc.value.obligation.obligationId)?.status,
      "DISPUTED",
    );
    assert.ok(lab.releaseDisputed(acc.value.obligation.obligationId).ok);
    assert.equal(lab.escrow.totalHeld("c"), 0n);
  });
});
