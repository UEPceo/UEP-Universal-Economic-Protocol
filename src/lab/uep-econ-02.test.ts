/**
 * UEP-ECON-02 — Service settlement lab + multinode economic finality
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  ServiceSettlementLab,
  resultDigestFromPayload,
  ECON_02_VERSION,
} from "./uep-econ-02.ts";
import {
  snapshotEconomic,
  buildReceipt,
  creatorFee,
  type EconomicStateView,
} from "./uep-econ-01.ts";

function view(n: { economic: EconomicStateView }): EconomicStateView {
  return n.economic;
}

describe("UEP-ECON-02 service settlement", () => {
  it("version", () => {
    assert.equal(ECON_02_VERSION, "ECON-02");
  });

  it("happy path: offer → accept → deliver → plan → settle registry", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("weather-ok-42");
    const offer = lab.registerOffer({
      providerId: "provider",
      serviceKind: "oracle.weather",
      price: 3000n,
      expectedResultDigest: expected,
    });
    assert.equal(offer.ok, true);
    if (!offer.ok) return;

    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "client",
      nonce: "n1",
    });
    assert.equal(obl.ok, true);
    if (!obl.ok) return;
    assert.equal(obl.value.status, "OPEN");

    const del = lab.submitDelivery({
      obligationId: obl.value.obligationId,
      providerId: "provider",
      resultDigest: expected,
    });
    assert.equal(del.ok, true);
    if (!del.ok) return;

    const plan = lab.planSettlement(obl.value.obligationId);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.value.tx.from, "client");
    assert.equal(plan.value.tx.to, "provider");
    assert.equal(plan.value.tx.amount, 3000n);
    assert.equal(plan.value.fee, 3n);
    assert.equal(plan.value.economicallyMeaningful, true);

    const marked = lab.markSettled(obl.value.obligationId, plan.value.tx.id);
    assert.equal(marked.ok, true);
    if (!marked.ok) return;
    assert.equal(marked.value.status, "SETTLED");

    // double settle rejected
    assert.equal(lab.markSettled(obl.value.obligationId, plan.value.tx.id).ok, false);
  });

  it("reject settlement without delivery", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("x");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "compute",
      price: 1000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "1",
    });
    assert.ok(obl.ok);
    if (!obl.ok) return;
    const plan = lab.planSettlement(obl.value.obligationId);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.reason, "NOT_DELIVERED");
  });

  it("digest mismatch → DISPUTED, no settlement", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("good");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "storage",
      price: 2000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "2",
    });
    assert.ok(obl.ok);
    if (!obl.ok) return;
    lab.submitDelivery({
      obligationId: obl.value.obligationId,
      providerId: "p",
      resultDigest: resultDigestFromPayload("evil"),
    });
    const plan = lab.planSettlement(obl.value.obligationId);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.reason, "DIGEST_MISMATCH");
    assert.equal(lab.obligations.get(obl.value.obligationId)?.status, "DISPUTED");
  });

  it("adversarial: non-provider cannot submit delivery", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("r");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "relay",
      price: 1000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "3",
    });
    assert.ok(obl.ok);
    if (!obl.ok) return;
    const bad = lab.submitDelivery({
      obligationId: obl.value.obligationId,
      providerId: "attacker",
      resultDigest: expected,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, "NOT_PROVIDER");
  });

  it("multinode: settlement TX is economically meaningful + conserved", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("job-result-7");
    const price = 5000n;
    const offer = lab.registerOffer({
      providerId: "provider",
      serviceKind: "compute.batch",
      price,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "client",
      nonce: "mn-1",
    });
    assert.ok(obl.ok);
    if (!obl.ok) return;
    assert.ok(
      lab.submitDelivery({
        obligationId: obl.value.obligationId,
        providerId: "provider",
        resultDigest: expected,
      }).ok,
    );
    const plan = lab.planSettlement(obl.value.obligationId);
    assert.ok(plan.ok);
    if (!plan.ok) return;

    const cluster = new MultiNodeCluster(4, 3901, {
      useSmtState: true,
      smtDepth: 8,
      poseidonZkLeaves: false,
      initialBalances: {
        client: 50_000n,
        provider: 0n,
        s0: 100n,
        r0: 0n,
      },
    });
    const leader = cluster.leaderForNextHeight();
    const before = snapshotEconomic(view(cluster.node(leader)));

    assert.ok(
      cluster.proposeAggregateFrom(leader, [{ txs: [plan.value.tx] }]),
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

    const after = snapshotEconomic(view(cluster.node("mn-0")));
    const receipt = buildReceipt({
      tx: plan.value.tx,
      before,
      after,
    });
    assert.equal(receipt.economicallyMeaningful, true);
    assert.equal(receipt.conservationHolds, true);
    assert.equal(receipt.fee, creatorFee(price).toString());
    assert.equal(cluster.node("mn-0").economic.balance("provider"), price);
    assert.equal(
      cluster.node("mn-0").economic.balance("client"),
      50_000n - plan.value.senderDebit,
    );
    assert.equal(cluster.node("mn-0").economic.treasuryBalance, plan.value.fee);

    const marked = lab.markSettled(obl.value.obligationId, plan.value.tx.id);
    assert.equal(marked.ok, true);
  });

  it("cancel open obligation blocks settlement", () => {
    const lab = new ServiceSettlementLab();
    const expected = resultDigestFromPayload("c");
    const offer = lab.registerOffer({
      providerId: "p",
      serviceKind: "s",
      price: 1000n,
      expectedResultDigest: expected,
    });
    assert.ok(offer.ok);
    if (!offer.ok) return;
    const obl = lab.acceptOffer({
      offerId: offer.value.offerId,
      clientId: "c",
      nonce: "x",
    });
    assert.ok(obl.ok);
    if (!obl.ok) return;
    assert.ok(lab.cancel(obl.value.obligationId, "c").ok);
    assert.equal(lab.planSettlement(obl.value.obligationId).ok, false);
  });
});
