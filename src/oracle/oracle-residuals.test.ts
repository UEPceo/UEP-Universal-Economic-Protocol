/**
 * v0.5.3 oracle registry and aggregation rules: rotated-out keys and revoked
 * sources stop counting at once and cannot come back; re-registration cannot
 * change weight or status; keys must be prime-order points; the oracle network
 * must match the ledger network; deterministic two-source price; vouchers need
 * a network; providers can delist a listing and publish it again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";
import { OraclePolicyGate } from "./policy-gate.ts";
import { AuthorizationLedger } from "./risk-policy.ts";
import { createOracleTestKey, makeQuote, registerOracleTestKey, signQuote, resetOracleSequence, type OracleTestKey } from "./testkit.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";

const BASE = "uep-test/tenergy";
const QUOTE = "uep-test/teur";
const H = 100;

function setup(keys: OracleTestKey[], minSources = 2) {
  resetOracleSequence(1n);
  const registry = new OracleRegistry();
  for (const k of keys) registerOracleTestKey(registry, k);
  registry.setPairPolicy({ baseAssetId: BASE, quoteAssetId: QUOTE, maxStalenessHeights: 12, maxDeviationPpm: 50_000n, minSources });
  const ag = new OracleAggregator({ defaultMinSources: minSources }, registry);
  const pub = (k: OracleTestKey, priceE6: bigint, h = H) => ag.publish(signQuote(makeQuote({ source: k.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6, observedAtHeight: h }), k.privateKey, k.publicKeyHex), h);
  return { registry, ag, pub };
}

test("a rotated-out key stops counting at rotation and can never be registered again", () => {
  const a = createOracleTestKey("a"), b = createOracleTestKey("b");
  const { registry, ag, pub } = setup([a, b]);
  assert.equal(pub(a, 1_000_000n).ok, true);
  assert.equal(pub(b, 1_000_000n).ok, true);
  assert.equal(ag.read(BASE, QUOTE, H).ok, true);
  const fresh = generateEd25519KeyPair();
  registry.rotateSourceKey("a", fresh.publicKeyHex, H);
  // The quote signed with a's old key no longer counts: only b is left.
  const r = ag.read(BASE, QUOTE, H);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NO_SOURCES");
  assert.throws(() => registry.registerSource({ sourceId: "a2", displayName: "x", publicKeyHex: a.publicKeyHex, weight: 10, status: "ACTIVE", registeredAtHeight: H }), /ORACLE_SOURCE_KEY_RETIRED/);
  assert.throws(() => registry.rotateSourceKey("b", a.publicKeyHex, H), /ORACLE_SOURCE_KEY_RETIRED/);
  assert.equal(registry.isKeyRetired(a.publicKeyHex), true);
});

test("re-registering with the same key cannot change the weight or revive a revoked source", () => {
  const a = createOracleTestKey("a"), b = createOracleTestKey("b"), c = createOracleTestKey("c");
  const { registry, ag, pub } = setup([a, b, c]);
  assert.throws(() => registry.registerSource({ sourceId: "a", displayName: "a", publicKeyHex: a.publicKeyHex, weight: 100, status: "ACTIVE", registeredAtHeight: 0 }), /cannot change the weight/);
  registry.setSourceStatus("c", "REVOKED");
  assert.throws(() => registry.registerSource({ sourceId: "c", displayName: "c", publicKeyHex: c.publicKeyHex, weight: 10, status: "ACTIVE", registeredAtHeight: 0 }), /cannot change the status|KEY_RETIRED/);
  assert.throws(() => registry.setSourceStatus("c", "ACTIVE"), /ORACLE_SOURCE_REVOKED/);
  assert.equal(registry.getSource("c")!.status, "REVOKED");
  // Metadata-only re-registration still works.
  registry.registerSource({ sourceId: "a", displayName: "renamed", publicKeyHex: a.publicKeyHex, weight: a.weight, registeredAtHeight: 0 } as never);
  assert.equal(registry.getSource("a")!.displayName, "renamed");
  assert.equal(registry.getSource("a")!.status, "ACTIVE");
  void ag; void pub;
});

test("a revoked or suspended source stops counting immediately (no wait for staleness)", () => {
  const a = createOracleTestKey("a"), b = createOracleTestKey("b"), c = createOracleTestKey("c");
  const { registry, ag, pub } = setup([a, b, c]);
  for (const k of [a, b, c]) assert.equal(pub(k, 1_000_000n).ok, true);
  assert.equal((ag.read(BASE, QUOTE, H) as { quote: { sourcesUsed: number } }).quote.sourcesUsed, 3);
  registry.setSourceStatus("c", "REVOKED");
  assert.equal((ag.read(BASE, QUOTE, H) as { quote: { sourcesUsed: number } }).quote.sourcesUsed, 2);
  registry.setSourceStatus("b", "SUSPENDED");
  assert.equal(ag.read(BASE, QUOTE, H).ok, false);
  registry.setSourceStatus("b", "ACTIVE");
  assert.equal(ag.read(BASE, QUOTE, H).ok, true);
});

test("small-order or identity keys are refused at registration and rotation", () => {
  const registry = new OracleRegistry();
  const ident = "01" + "00".repeat(31);
  assert.throws(() => registry.registerSource({ sourceId: "z", displayName: "z", publicKeyHex: ident, weight: 10, status: "ACTIVE", registeredAtHeight: 0 }), /ORACLE_REGISTRY/);
  const a = createOracleTestKey("a");
  registerOracleTestKey(registry, a);
  assert.throws(() => registry.rotateSourceKey("a", ident, 1), /ORACLE_REGISTRY/);
});

test("two sources: the price is the floor of their mean, whatever the weights or their order", () => {
  for (const [wa, wb] of [[100, 1], [1, 100], [10, 10]]) {
    const a = createOracleTestKey("a", "a", wa), b = createOracleTestKey("b", "b", wb);
    const { ag, pub } = setup([a, b]);
    pub(a, 1_000_000n);
    pub(b, 960_001n);
    const r = ag.read(BASE, QUOTE, H) as { ok: true; quote: { priceE6: bigint } };
    assert.equal(r.ok, true);
    assert.equal(r.quote.priceE6, 980_000n);
  }
});

test("the oracle network must match the ledger network; legacy unbound quotes are refused by the gate", () => {
  const admin = createTestAuthority("admin");
  const registry = new OracleRegistry();
  const foreign = new OraclePolicyGate(new OracleAggregator({ networkId: "uep-global-1" }, registry));
  assert.throws(() => new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => 1, oracleGate: foreign }), /ORACLE_NETWORK_MISMATCH/);
  assert.ok(new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => 1, oracleGate: foreign, ledgerNetworkId: "uep-global-1" }));
  assert.throws(() => new OraclePolicyGate(new OracleAggregator({ acceptLegacyV1Quotes: true }, registry)), /ORACLE_GATE_LEGACY_QUOTES/);
  assert.throws(() => new OraclePolicyGate(new OracleAggregator({}, registry), { expectedNetworkId: "uep-global-1" }), /ORACLE_NETWORK_MISMATCH/);
});

test("vouchers: an AuthorizationLedger without a networkId is refused", () => {
  assert.throws(() => new AuthorizationLedger({ trustedAuthorityKeys: [generateEd25519KeyPair().publicKeyHex] }), /AUTH_NETWORK_REQUIRED/);
});

test("a provider can delist a listing; running orders continue and the same terms can be published again", () => {
  const admin = createTestAuthority("admin");
  const m = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => 10 });
  const terms = { providerId: "p1", title: "delist me", description: "d", category: "COMPUTE" as const, asset: QUOTE, unitPrice: 20n, capacity: 10n };
  const l = publishAs(m, terms);
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b1", quantity: 1n });
  assert.throws(() => publishAs(m, terms), /DUPLICATE_LISTING_FINGERPRINT/);
  assert.throws(() => m.delistListing(l.listingId, act(m, "b1", "delist", l.listingId)), /PROVIDER_NOT_AUTHORIZED/);
  assert.throws(() => m.delistListing(l.listingId, act(m, "p1", "delist", "other-listing")), /SIGNATURE|NOT_AUTHORIZED/);
  assert.equal(m.delistListing(l.listingId, act(m, "p1", "delist", l.listingId)).active, false);
  assert.throws(() => reserveAs(m, { listingId: l.listingId, buyerId: "b2", quantity: 1n }), /LISTING_NOT_FOUND/);
  fund(m, o.orderId, o.fundingDue, undefined, "b1");
  deliver(m, o.orderId, "p1", Buffer.from("x"));
  assert.equal(settle(m, o.orderId, "b1").outcome, "RELEASE");
  assert.equal(publishAs(m, terms).active, true);
});
