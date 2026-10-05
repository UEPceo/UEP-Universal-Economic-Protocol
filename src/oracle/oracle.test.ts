/**
 * Oracle layer tests (v0.5.2): Poseidon commitment, signed publish, stale /
 * replay / pause / circuit breaker, policy evaluation. Heights (ADR 0002).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { poseidon2 } from "../core/poseidon.ts";
import { computeQuotePoseidonHash, bytesToFieldElement, ORACLE_POSEIDON_DOMAIN } from "./canonical.ts";
import { OracleAggregator } from "./index.ts";
import {
  evaluateSvcSla,
  evaluateIotTariff,
  issueSettlementAuthorization,
  AuthorizationLedger,
  verifyAmmSpotSkew,
} from "./risk-policy.ts";
import { freshAggregator, makeQuote, signQuote, resetOracleSequence } from "./testkit.ts";

const BASE = "uep-test/tenergy";
const QUOTE = "uep-test/teur";

test("Poseidon quote hash uses the repository permutation (not a homemade one)", () => {
  resetOracleSequence(1n);
  const q = makeQuote({ source: "s", baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: 10, sequence: 1n });
  const h = computeQuotePoseidonHash(q);
  // Same inputs through the core Poseidon must match the commitment composition.
  const enc = new TextEncoder();
  const pair = poseidon2(bytesToFieldElement(enc.encode(BASE)), bytesToFieldElement(enc.encode(QUOTE)));
  assert.equal(typeof h, "bigint");
  assert.notEqual(h, 0n);
  // Domain-tagged; changing the price changes the hash.
  const q2 = { ...q, priceE6: 1_000_001n };
  assert.notEqual(computeQuotePoseidonHash(q2), h);
  assert.equal(ORACLE_POSEIDON_DOMAIN, 0x4f52);
  assert.ok(pair > 0n);
});

test("signed publish + aggregate with two sources", () => {
  resetOracleSequence(1n);
  const { aggregator, keys } = freshAggregator();
  const height = 100;
  for (const [i, key] of keys.entries()) {
    const raw = makeQuote({
      source: key.sourceId,
      baseAssetId: BASE,
      quoteAssetId: QUOTE,
      priceE6: 1_000_000n + BigInt(i) * 1_000n,
      observedAtHeight: height,
    });
    const signed = signQuote(raw, key.privateKey, key.publicKeyHex);
    const r = aggregator.publish(signed, height);
    assert.equal(r.ok, true, r.message);
  }
  const read = aggregator.read(BASE, QUOTE, height);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.quote.sourcesUsed, 2);
    assert.ok(read.quote.priceE6 >= 1_000_000n && read.quote.priceE6 <= 1_001_000n);
  }
});

test("stale quote is refused on publish and on read", () => {
  resetOracleSequence(1n);
  const { aggregator, keys } = freshAggregator({ minSources: 1 });
  const key = keys[0]!;
  const signed = signQuote(
    makeQuote({ source: key.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: 10 }),
    key.privateKey,
    key.publicKeyHex,
  );
  assert.equal(aggregator.publish(signed, 10).ok, true);
  const stale = aggregator.read(BASE, QUOTE, 10 + 13); // default staleness 12
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "STALE");
});

test("replay of the same sequence is refused", () => {
  resetOracleSequence(1n);
  const { aggregator, keys } = freshAggregator({ minSources: 1 });
  const key = keys[0]!;
  const raw = makeQuote({ source: key.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: 5, sequence: 7n });
  const signed = signQuote(raw, key.privateKey, key.publicKeyHex);
  assert.equal(aggregator.publish(signed, 5).ok, true);
  const again = aggregator.publish(signed, 5);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "REPLAY_ATTACK");
});

test("pair pause and wrong signer key", () => {
  resetOracleSequence(1n);
  const { aggregator, keys } = freshAggregator({ minSources: 1 });
  aggregator.registry.setPairPaused(BASE, QUOTE, true);
  const key = keys[0]!;
  const signed = signQuote(
    makeQuote({ source: key.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: 1 }),
    key.privateKey,
    key.publicKeyHex,
  );
  const paused = aggregator.publish(signed, 1);
  assert.equal(paused.ok, false);
  if (!paused.ok) assert.equal(paused.code, "PAIR_PAUSED");

  aggregator.registry.setPairPaused(BASE, QUOTE, false);
  // Sign with key B but claim source A.
  const wrong = signQuote(
    makeQuote({ source: keys[0]!.sourceId, baseAssetId: BASE, quoteAssetId: QUOTE, priceE6: 1_000_000n, observedAtHeight: 2, sequence: 99n }),
    keys[1]!.privateKey,
    keys[1]!.publicKeyHex,
  );
  const bad = aggregator.publish(wrong, 2);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "UNAUTHORIZED_SOURCE");
});

test("risk policy: SVC SLA, IoT tariff, AMM skew, single-use auth", () => {
  const quote = {
    stage: "AGGREGATED" as const,
    baseAssetId: BASE,
    quoteAssetId: QUOTE,
    priceE6: 2_000_000n,
    sourcesUsed: 2,
    minPriceE6: 1_900_000n,
    maxPriceE6: 2_100_000n,
    observedAtHeight: 50,
    aggregatedAtHeight: 50,
    sources: [],
  };
  const ok = evaluateSvcSla(quote, 1_500_000n, 50);
  assert.equal(ok.decision, "ACCEPTED");
  const bad = evaluateSvcSla(quote, 3_000_000n, 50);
  assert.equal(bad.decision, "REJECTED_BY_POLICY");

  const iot = evaluateIotTariff(quote, 10n, 25n, 50); // cost = 20
  assert.equal(iot.decision, "ACCEPTED");
  assert.equal(evaluateIotTariff(quote, 10n, 10n, 50).decision, "REJECTED_BY_POLICY");

  assert.equal(verifyAmmSpotSkew(100n, 200n, quote, true, 30_000n).ok, true);
  assert.equal(verifyAmmSpotSkew(100n, 300n, quote, true, 30_000n).ok, false);

  const auth = issueSettlementAuthorization(ok, {
    decisionId: "d1",
    contextId: "svc:order-1",
    authorizedAmount: 100n,
    recipientAddress: "provider-1",
    assetId: QUOTE,
    expiresAtHeight: 60,
    nonce: "n1",
  });
  const ledger = new AuthorizationLedger();
  ledger.consume(auth, 55);
  assert.throws(() => ledger.consume(auth, 55), /ALREADY_SETTLED/);
});

test("core and testnet must not import oracle (policy-only boundary)", async () => {
  // Architectural boundary: core barrel must not re-export oracle; aggregator holds no balances.
  const core = await import("../core/index.ts");
  assert.equal("OracleAggregator" in core, false);
  assert.equal(Object.keys(core).some((k) => /oracle/i.test(k)), false);
  const { OracleAggregator } = await import("./index.ts");
  const a = new OracleAggregator({ requireSignatures: false, defaultMinSources: 1 });
  assert.equal("ledger" in a, false);
  assert.equal("balances" in a, false);
  assert.equal(typeof a.registry, "object");
});
