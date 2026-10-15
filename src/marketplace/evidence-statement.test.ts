import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { evidenceStatementMessage } from "./evidence.ts";
import { TESTNET } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { deriveSpendKey } from "../core/spend-key.ts";
import { signEd25519 } from "../core/ed25519.ts";
import { contentHash } from "../service/content-hash.ts";
import { deliver, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";

const keys = [1, 2, 3].map((i) => deriveSpendKey(new Fr(BigInt(i)), new Fr(9n)));
const SET = {
  attesterSetId: "space-weather-2of3",
  sourceId: "https://example.org/space-weather/v1",
  attesterKeys: keys.map((k) => k.publicKeyHex.slice(-64)),
  threshold: 2,
  size: 3,
  valueCaps: { EUR: 1_000n },
  providerCapBps: 10_000,
  buyerCapBps: 10_000,
  providerBondBps: 0,
};

function statement(orderId: string, dataHash: string, height: number) {
  const body = { sourceId: SET.sourceId, dataHash, observedHeight: height, orderId, attesterSetId: SET.attesterSetId };
  const message = evidenceStatementMessage(body, TESTNET.networkId);
  return {
    ...body,
    signatures: keys.slice(0, 2).map((k) => ({ attesterId: k.publicKeyHex.slice(-64), signature: signEd25519(message, k.privateKey) })),
  };
}

test("an evidence-bound order does not settle without a statement, and the bytes stay out", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [SET] } });
  const listing = publishAs(m, { providerId: "prov", title: "link", description: "d", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n, evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
  fund(m, order.orderId, order.fundingDue);
  const bytes = Buffer.from("published-observation");
  deliver(m, order.orderId, "prov", bytes);
  assert.throws(() => settle(m, order.orderId, "buyer"), /EVIDENCE_REQUIRED/);
  m.submitEvidence(order.orderId, statement(order.orderId, contentHash(bytes), m.exportSnapshot().height));
  settle(m, order.orderId, "buyer");
  assert.equal(getOrder(m, order.orderId, "buyer").status, "SETTLED");
  const stored = m.exportSnapshot().state!.marketplace.evidenceStatements as { $m: unknown[] };
  assert.equal(JSON.stringify(stored).includes("published-observation"), false);
});

test("a statement bound to one order cannot be submitted on another", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [SET] } });
  const listing = publishAs(m, { providerId: "prov", title: "link", description: "d", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n, evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
  assert.throws(() => m.submitEvidence(order.orderId, statement("other-order", "ab".repeat(32), 1)), /EVIDENCE_ORDER_MISMATCH/);
});
