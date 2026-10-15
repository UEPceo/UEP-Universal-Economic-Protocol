/**
 * 0.5.82 (Research external sources, fixes 2-5, 8, 10): evidence statements
 * bound to the local network, age and reservation bounds, signed no-evidence
 * outcome, canonical claims and distinct source sets (structure only).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { evidenceStatementMessage, canonicalEvidenceClaim, checkDistinctSourceSets, checkClaimAgreement, type EvidenceStatement } from "./evidence.ts";
import { Fr } from "../core/field.ts";
import { deriveSpendKey } from "../core/spend-key.ts";
import { signEd25519 } from "../core/ed25519.ts";
import { contentHash } from "../service/content-hash.ts";
import { TESTNET } from "../network/profiles.ts";
import { act, deliver, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";

const keys = [1, 2, 3].map((i) => deriveSpendKey(new Fr(BigInt(i)), new Fr(77n)));
const pub = (k: (typeof keys)[number]) => k.publicKeyHex.slice(-64);
const SET = { attesterSetId: "seismic-2of3", sourceId: "https://example.org/seismic/v1", attesterKeys: keys.map(pub), threshold: 2, size: 3, valueCaps: { EUR: 1_000n }, providerCapBps: 10_000, buyerCapBps: 10_000, providerBondBps: 0 };
const BYTES = Buffer.from("published-observation");

type Opts = { maxAgeHeights?: number; onNoEvidence?: "REFUND" | "RELEASE"; evidenceDeadlineHeight?: number };
function setup(policy: Opts = {}, config: Record<string, unknown> = {}) {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [SET] }, ...config });
  m.advanceHeight(10);
  const listing = publishAs(m, { providerId: "prov", title: "quake", description: "d", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n, evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n, ...policy } });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
  fund(m, order.orderId, order.fundingDue);
  deliver(m, order.orderId, "prov", BYTES);
  return { m, orderId: order.orderId, createdAt: order.createdAt };
}

function statement(orderId: string, height: number, o: { network?: string; version?: 1 | 2; signers?: number; dataHash?: string } = {}): EvidenceStatement {
  const body = { sourceId: SET.sourceId, dataHash: o.dataHash ?? contentHash(BYTES), observedHeight: height, orderId, attesterSetId: SET.attesterSetId, ...(o.version ? { version: o.version } : {}) };
  const message = evidenceStatementMessage(body, o.network ?? TESTNET.networkId);
  return { ...body, signatures: keys.slice(0, o.signers ?? 2).map((k) => ({ attesterId: pub(k), signature: signEd25519(message, k.privateKey) })) };
}

test("v2 statement signed for another network is refused; local network accepted", () => {
  const { m, orderId } = setup();
  const h = m.exportSnapshot().height;
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, h, { network: "uep-other-net" })), /EVIDENCE_SIGNATURE_INVALID/);
  m.submitEvidence(orderId, statement(orderId, h));
  settle(m, orderId, "buyer");
  assert.equal(getOrder(m, orderId, "buyer").status, "SETTLED");
});

test("v1 statements only with explicit archive acceptance", () => {
  const a = setup();
  const h = a.m.exportSnapshot().height;
  assert.throws(() => a.m.submitEvidence(a.orderId, statement(a.orderId, h, { version: 1 })), /EVIDENCE_V1_NOT_ACCEPTED/);
  const b = setup({}, { acceptEvidenceV1Archive: true });
  b.m.submitEvidence(b.orderId, statement(b.orderId, b.m.exportSnapshot().height, { version: 1 }));
});

test("observation before the reservation, in the future, or older than maxAgeHeights is refused", () => {
  const { m, orderId, createdAt } = setup({ maxAgeHeights: 5 });
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, createdAt - 1)), /EVIDENCE_BEFORE_RESERVATION/);
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, m.exportSnapshot().height + 1)), /EVIDENCE_FUTURE/);
  const observed = m.exportSnapshot().height;
  m.advanceHeight(6);
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, observed)), /EVIDENCE_EXPIRED/);
});

test("timeout without quorum: below-threshold statement refused, signed REFUND applies after the deadline", () => {
  const { m, orderId } = setup({ onNoEvidence: "REFUND", evidenceDeadlineHeight: 20 });
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, m.exportSnapshot().height, { signers: 1 })), /EVIDENCE_THRESHOLD/);
  assert.throws(() => m.resolveNoEvidence(orderId, act(m, "buyer", "expire", orderId)), /EVIDENCE_DEADLINE_NOT_REACHED/);
  m.advanceHeight(25);
  const r = m.resolveNoEvidence(orderId, act(m, "buyer", "expire", orderId));
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(getOrder(m, orderId, "buyer").status, "REFUNDED");
  assert.equal(getOrder(m, orderId, "buyer").disputeOutcome, "NO_EVIDENCE_REFUND");
});

test("all sources down: two nodes reach the identical final state (REFUND and RELEASE)", () => {
  for (const onNoEvidence of ["REFUND", "RELEASE"] as const) {
    const roots = [0, 1].map(() => {
      const { m, orderId } = setup({ onNoEvidence, evidenceDeadlineHeight: 20 });
      m.advanceHeight(25);
      m.resolveNoEvidence(orderId, act(m, "prov", "expire", orderId));
      const o = getOrder(m, orderId, "buyer");
      assert.equal(o.status, onNoEvidence === "REFUND" ? "REFUNDED" : "SETTLED");
      // Node-local ids differ between two instances; compare the economic outcome.
      return JSON.stringify({ status: o.status, payout: String(o.providerPayout), refund: String(o.buyerRefund), fee: String(o.settledFee), outcome: o.disputeOutcome, buyer: String(m.availableBalance("EUR", "buyer")), prov: String(m.availableBalance("EUR", "prov")) });
    });
    assert.equal(roots[0], roots[1]);
  }
});

test("no-evidence outcome is refused when a statement exists, and policy fields are validated", () => {
  const { m, orderId } = setup({ onNoEvidence: "RELEASE", evidenceDeadlineHeight: 5 });
  m.submitEvidence(orderId, statement(orderId, m.exportSnapshot().height));
  m.advanceHeight(10);
  assert.throws(() => m.resolveNoEvidence(orderId, act(m, "buyer", "expire", orderId)), /EVIDENCE_PRESENT/);
  assert.throws(() => setup({ onNoEvidence: "RELEASE" }), /EVIDENCE_POLICY_INVALID/);
  assert.throws(() => setup({ maxAgeHeights: -1 }), /EVIDENCE_POLICY_INVALID/);
});

test("discrepant sources: a second statement with another data hash is refused (EVIDENCE_CONFLICT)", () => {
  const { m, orderId } = setup();
  const h = m.exportSnapshot().height;
  m.submitEvidence(orderId, statement(orderId, h));
  assert.throws(() => m.submitEvidence(orderId, statement(orderId, h, { dataHash: "cd".repeat(32) })), /EVIDENCE_CONFLICT/);
});

test("canonical claim and distinct source sets (structure; tolerances residual)", () => {
  const claim = { kind: "SEISMIC" as const, minMagnitudeTenths: 45, latMinMicro: 35_000_000, latMaxMicro: 44_000_000, lonMinMicro: -10_000_000, lonMaxMicro: 4_000_000, fromHeight: 100, toHeight: 200 };
  const c = canonicalEvidenceClaim(claim);
  assert.equal(c, canonicalEvidenceClaim({ ...claim }));
  assert.throws(() => canonicalEvidenceClaim({ ...claim, latMinMicro: 50_000_000 }), /EVIDENCE_CLAIM_INVALID/);
  assert.throws(() => canonicalEvidenceClaim({ ...claim, minMagnitudeTenths: 4.5 }), /EVIDENCE_CLAIM_INVALID/);
  const claimHash = createHash("sha256").update(c).digest("hex");
  const setB = { ...SET, attesterSetId: "seismic-b", sourceId: "https://example.org/seismic-b/v1", attesterKeys: ["aa".repeat(32)] };
  const st = (id: string) => ({ sourceId: "", dataHash: "00".repeat(32), observedHeight: 1, orderId: "o", attesterSetId: id, claimHash, signatures: [] });
  checkDistinctSourceSets([st(SET.attesterSetId), st(setB.attesterSetId)], [SET, setB], 2, claimHash);
  assert.throws(() => checkDistinctSourceSets([st(SET.attesterSetId)], [SET, setB], 2, claimHash), /EVIDENCE_SOURCES_INSUFFICIENT/);
  assert.throws(() => checkDistinctSourceSets([st(SET.attesterSetId), st(SET.attesterSetId)], [SET], 2, claimHash), /EVIDENCE_SOURCE_NOT_DISTINCT/);
  assert.throws(() => checkDistinctSourceSets([{ ...st(SET.attesterSetId), claimHash: "11".repeat(32) }], [SET], 1, claimHash), /EVIDENCE_CLAIM_MISMATCH/);
  assert.throws(() => checkClaimAgreement(), /EVIDENCE_TOLERANCES_UNSET/);
});

test("snapshot: evidence statements and the new policy fields survive export/restore unchanged", () => {
  const { m, orderId } = setup({ maxAgeHeights: 50, onNoEvidence: "REFUND", evidenceDeadlineHeight: 30 });
  m.submitEvidence(orderId, statement(orderId, m.exportSnapshot().height));
  const snap = m.exportSnapshot();
  const n = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [SET] } });
  n.advanceHeight(snap.height);
  n.restoreSnapshot(snap, { snapshotPublicKeys: m.snapshotPublicKeys() });
  assert.equal(n.exportSnapshot().snapshotHash, snap.snapshotHash);
});
