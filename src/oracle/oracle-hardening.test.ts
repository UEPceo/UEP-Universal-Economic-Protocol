/**
 * v0.5.3 oracle hardening (EXP-063 / V-1..V-5). One negative test per issue,
 * plus compatibility of archived v0.1 quotes behind an explicit opt-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";
import { canonicalQuotePayload, canonicalQuotePayloadV1, quoteDomainSeparator } from "./canonical.ts";
import { AuthorizationLedger, issueSettlementAuthorization, settlementAuthorizationHash } from "./risk-policy.ts";
import { createOracleTestKey, makeQuote, registerOracleTestKey, signQuote, signQuoteV1, resetOracleSequence } from "./testkit.ts";
import type { EconomicEvaluation } from "./types.ts";

const BASE = "uep-test/tenergy";
const QUOTE = "uep-test/teur";
const H = 100;

function agg(keys: ReturnType<typeof createOracleTestKey>[], policy: Partial<ConstructorParameters<typeof OracleAggregator>[0]> = {}) {
  const registry = new OracleRegistry();
  for (const k of keys) registerOracleTestKey(registry, k);
  return new OracleAggregator({ defaultMinSources: 2, ...policy }, registry);
}
const pub = (a: OracleAggregator, k: ReturnType<typeof createOracleTestKey>, priceE6: bigint, networkId?: string) =>
  a.publish(signQuote(makeQuote({ source: k.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6, observedAtHeight: H }), k.privateKey, k.publicKeyHex, networkId), H);

test("V-1: one key registered under two source ids is refused, and quotes are counted per key", () => {
  resetOracleSequence(1n);
  const a = createOracleTestKey("src-a");
  const registry = new OracleRegistry();
  registerOracleTestKey(registry, a);
  assert.throws(() => registry.registerSource({ sourceId: "src-a-clone", displayName: "clone", publicKeyHex: a.publicKeyHex, weight: 10, status: "ACTIVE", registeredAtHeight: 0 }), /ORACLE_SOURCE_KEY_IN_USE/);
  // Even if one key reaches a feed under two names (unregistered, signatures off), minSources counts it once.
  const loose = new OracleAggregator({ requireSignatures: false, defaultMinSources: 2 });
  const q1 = { ...makeQuote({ source: "x1", baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: H }), signerPublicKeyHex: a.publicKeyHex, signature: "00" };
  const q2 = { ...q1, source: "x2", sequence: q1.sequence + 1n };
  assert.equal(loose.publish(q1 as never, H).ok, true);
  assert.equal(loose.publish(q2 as never, H).ok, true);
  const r = loose.read(BASE, QUOTE, H);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "NO_SOURCES");
});

test("V-2: re-registering a source id with another key is refused; rotation is explicit", () => {
  const a = createOracleTestKey("src-a");
  const b = createOracleTestKey("src-b");
  const registry = new OracleRegistry();
  registerOracleTestKey(registry, a);
  registerOracleTestKey(registry, b);
  const evil = generateEd25519KeyPair();
  assert.throws(() => registry.registerSource({ sourceId: "src-a", displayName: "A", publicKeyHex: evil.publicKeyHex, weight: 10, status: "ACTIVE", registeredAtHeight: 5 }), /ORACLE_SOURCE_EXISTS/);
  assert.equal(registry.getSource("src-a")!.publicKeyHex, a.publicKeyHex);
  // Same key: metadata update only.
  registry.registerSource({ sourceId: "src-a", displayName: "A renamed", publicKeyHex: a.publicKeyHex, weight: 20, status: "ACTIVE", registeredAtHeight: 0 });
  assert.equal(registry.getSource("src-a")!.displayName, "A renamed");
  assert.throws(() => registry.rotateSourceKey("src-a", b.publicKeyHex, 7), /ORACLE_SOURCE_KEY_IN_USE/);
  assert.equal(registry.rotateSourceKey("src-a", evil.publicKeyHex, 7), a.publicKeyHex);
  assert.equal(registry.getSource("src-a")!.keyRotatedAtHeight, 7);
  // After rotation the old key no longer signs for the source.
  const ag = new OracleAggregator({ defaultMinSources: 1 }, registry);
  const r = ag.publish(signQuote(makeQuote({ source: "src-a", baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1n, observedAtHeight: H }), a.privateKey, a.publicKeyHex), H);
  assert.equal(r.code, "UNAUTHORIZED_SOURCE");
});

test("V-3: quotes signed for another network or domain are refused; networkId is in the payload", () => {
  resetOracleSequence(1n);
  const a = createOracleTestKey("src-a");
  const ag = agg([a], { networkId: "uep-testnet-1", defaultMinSources: 1 });
  const foreign = pub(ag, a, 1_000_000n, "uep-global-1");
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "DOMAIN_MISMATCH");
  // A forged local domain label on a quote signed for another network fails the signature.
  const q = makeQuote({ source: a.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: H });
  const s = signQuote(q, a.privateKey, a.publicKeyHex, "uep-global-1");
  const relabelled = ag.publish({ ...s, domainSeparator: quoteDomainSeparator("uep-testnet-1") }, H);
  assert.equal(relabelled.code, "INVALID_SIGNATURE");
  // A domain chosen by the signer ("OTHER_NETWORK_ORACLE_v9") is refused.
  const q2 = makeQuote({ source: a.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: H });
  assert.equal(ag.publish({ ...signQuote(q2, a.privateKey, a.publicKeyHex), domainSeparator: "OTHER_NETWORK_ORACLE_v9" }, H).code, "DOMAIN_MISMATCH");
  assert.notDeepEqual(canonicalQuotePayload(q, { networkId: "uep-testnet-1" }), canonicalQuotePayload(q, { networkId: "uep-global-1" }));
  assert.throws(() => canonicalQuotePayload(q, undefined as never), /ORACLE_NETWORK_REQUIRED/);
  assert.equal(pub(ag, a, 1_000_000n).ok, true);
});

test("V-3 compatibility: archived v0.1 quotes verify only with acceptLegacyV1Quotes", () => {
  resetOracleSequence(1n);
  const a = createOracleTestKey("src-a");
  const q = makeQuote({ source: a.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: H });
  const v1 = signQuoteV1(q, a.privateKey, a.publicKeyHex);
  assert.ok(canonicalQuotePayloadV1(q).length > 0);
  assert.equal(agg([a], { defaultMinSources: 1 }).publish(v1, H).ok, false);
  assert.equal(agg([a], { defaultMinSources: 1, acceptLegacyV1Quotes: true }).publish(v1, H).ok, true);
});

test("V-4: weights 100/1/1 — the heavy source cannot impose its price on two agreeing sources", () => {
  resetOracleSequence(1n);
  const heavy = createOracleTestKey("heavy", "heavy", 100);
  const b = createOracleTestKey("b", "b", 1);
  const c = createOracleTestKey("c", "c", 1);
  for (const [heavyPrice] of [[1_040_000n], [960_000n]] as const) {
    const ag = agg([heavy, b, c], { defaultMaxDeviationPpm: 100_000n });
    assert.equal(pub(ag, heavy, heavyPrice).ok, true);
    assert.equal(pub(ag, b, 1_000_000n).ok, true);
    assert.equal(pub(ag, c, 1_000_000n).ok, true);
    const r = ag.read(BASE, QUOTE, H);
    assert.equal(r.ok && r.quote.priceE6, 1_000_000n, `heavy at ${heavyPrice}`);
  }
  const ag = agg([heavy, b, c]);
  assert.deepEqual(ag.effectiveWeights([100, 1, 1]), [1n, 1n, 1n]);
  assert.deepEqual(ag.effectiveWeights([10, 10, 10]), [10n, 10n, 10n]);
});

test("V-5: forged, edited, foreign or unsigned SettlementAuthorization vouchers are refused", () => {
  const authority = generateEd25519KeyPair();
  const attacker = generateEd25519KeyPair();
  const evaluation: EconomicEvaluation = { decision: "ACCEPTED", evaluatedAtHeight: 50, aggregatedQuote: { stage: "AGGREGATED", baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1n, sourcesUsed: 2, minPriceE6: 1n, maxPriceE6: 1n, observedAtHeight: 50, aggregatedAtHeight: 50, sources: [] } };
  const params = { decisionId: "d1", contextId: "svc:o1", authorizedAmount: 100n, recipientAddress: "p1", assetId: QUOTE, expiresAtHeight: 60, nonce: "n1", networkId: "uep-testnet-1" };
  const ledger = new AuthorizationLedger({ trustedAuthorityKeys: [authority.publicKeyHex], networkId: "uep-testnet-1" });
  const good = issueSettlementAuthorization(evaluation, params, authority.privateKey);
  // Hand-made voucher (the v0.5.2 shape) is refused.
  const forged = { authorized: true as const, decisionId: "x", contextId: "svc:o1", policyHash: "00", authorizedAmount: 10n ** 9n, recipientAddress: "attacker", assetId: QUOTE, issuedAtHeight: 50, expiresAtHeight: 10_000, nonce: "z" };
  assert.throws(() => ledger.consume(forged, 55), /AUTH_UNSIGNED/);
  assert.throws(() => ledger.consume({ ...good, authorizedAmount: 10n ** 9n }, 55), /AUTH_FORGED/);
  const edited = { ...good, recipientAddress: "attacker" };
  assert.throws(() => ledger.consume({ ...edited, authorizationHash: settlementAuthorizationHash(edited) }, 55), /AUTH_FORGED: bad signature/);
  assert.throws(() => ledger.consume(issueSettlementAuthorization(evaluation, params, attacker.privateKey), 55), /not a trusted policy authority/);
  assert.throws(() => ledger.consume(issueSettlementAuthorization(evaluation, { ...params, networkId: "uep-global-1" }, authority.privateKey), 55), /AUTH_NETWORK_MISMATCH/);
  assert.throws(() => ledger.consume(good, 61), /AUTH_EXPIRED/);
  ledger.consume(good, 55);
  assert.throws(() => ledger.consume(good, 55), /ALREADY_SETTLED/);
});

test("publishSync is refused on a signature-checking aggregator", () => {
  const ag = agg([]);
  assert.throws(() => ag.publishSync(makeQuote({ source: "s", baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1n, observedAtHeight: H })), /ORACLE_PUBLISH_SYNC_REFUSED/);
});
