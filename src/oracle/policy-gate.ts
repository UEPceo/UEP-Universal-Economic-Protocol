/**
 * v0.5.3 oracle policy gate: the single place where Marketplace listings,
 * IoT tariffs and hashlock swaps consult the oracle. Pure and synchronous: it
 * reads the aggregator at the caller's height (ADR 0002) and throws
 * ORACLE_* errors; it never moves funds and holds no balance.
 *
 * Opt-in and signed (v0.5.3): a path consults the oracle only when its own
 * signed terms ask for it (a listing's `oracleReference`, a swap intent's
 * `oracleBand`). Operator configuration never makes a path oracle-bound.
 * A quote that is available and outside the signed band rejects the new
 * operation (ORACLE_POLICY_REJECTED). When the oracle is unavailable (no
 * gate, stale, unknown or paused pair, no or too few agreeing sources), the
 * signed `onOracleUnavailable` decides: "FOLLOW_SIGNED_PRICE" (default)
 * continues at the signed price and records that the oracle was unavailable;
 * "BLOCK_NEW" refuses new operations only. Refunds, timeouts, disputes,
 * settlement and transfers never consult the oracle.
 *
 * Prices are always between two concrete assets (no reference unit, no
 * common currency): `priceE6` is quote-asset units per base-asset unit × 10^6.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.ts";
import { PPM_SCALE, PRICE_SCALE, type AggregatedQuote, type EconomicEvaluation } from "./types.ts";
import type { OracleAggregator } from "./index.ts";
import { evaluateIotTariff, verifyAmmSpotSkew } from "./risk-policy.ts";

/**
 * Oracle terms of a listing (signed with the listing terms): the listing's
 * `unitPrice` (in the listing asset) must stay within `maxDeviationPpm` of
 * `baseUnitsPerQuantity` units of `baseAssetId` priced by the oracle in the
 * listing asset.
 */
export type OracleReferenceTerms = {
  baseAssetId: string;
  baseUnitsPerQuantity: bigint;
  maxDeviationPpm: bigint;
  /** v0.5.3: what new operations do while the oracle is unavailable (signed; default FOLLOW_SIGNED_PRICE). */
  onOracleUnavailable?: OracleUnavailablePolicy;
};

/** v0.5.3: signed default outcome when the oracle cannot answer. */
export type OracleUnavailablePolicy = "FOLLOW_SIGNED_PRICE" | "BLOCK_NEW";
export const DEFAULT_ON_ORACLE_UNAVAILABLE: OracleUnavailablePolicy = "FOLLOW_SIGNED_PRICE";

/**
 * v0.5.3: what an oracle check decided, stored with the order / swap so the
 * outcome can be replayed: IN_BAND with the hash of the aggregated quote that
 * was used, or ORACLE_UNAVAILABLE (signed price followed) with the reason.
 */
export type OracleCheckRecord = {
  outcome: "IN_BAND" | "ORACLE_UNAVAILABLE_SIGNED_PRICE";
  height: number;
  quoteHash?: string;
  reason?: string;
};

export const MAX_ORACLE_DEVIATION_PPM = 500_000n;
const AGG_QUOTE_HASH_DOMAIN = "UEP-ORACLE-AGGREGATED-QUOTE-v1";

/** v0.5.3: commitment to the aggregated quote an operation was checked against. */
export function aggregatedQuoteHash(q: AggregatedQuote): string {
  const body = {
    baseAssetId: q.baseAssetId,
    quoteAssetId: q.quoteAssetId,
    priceE6: q.priceE6,
    sourcesUsed: q.sourcesUsed,
    minPriceE6: q.minPriceE6,
    maxPriceE6: q.maxPriceE6,
    observedAtHeight: q.observedAtHeight,
    aggregatedAtHeight: q.aggregatedAtHeight,
    contextId: q.contextId ?? null,
    sources: q.sources.map((x) => ({ source: x.source, priceE6: x.priceE6, observedAtHeight: x.observedAtHeight, weight: x.weight })),
  };
  return createHash("sha256").update(canonicalJson([AGG_QUOTE_HASH_DOMAIN, body])).digest("hex");
}

export function assertOracleUnavailablePolicy(p: unknown): OracleUnavailablePolicy | undefined {
  if (p === undefined) return undefined;
  if (p !== "FOLLOW_SIGNED_PRICE" && p !== "BLOCK_NEW") throw new Error("ORACLE_UNAVAILABLE_POLICY_INVALID: FOLLOW_SIGNED_PRICE or BLOCK_NEW");
  return p;
}

/**
 * True for oracle errors that mean "no usable answer" (as opposed to an answer
 * outside the signed band): not configured, stale, unknown or paused pair,
 * no sources, or sources that disagree beyond the pair band.
 */
export function isOracleUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^ORACLE_(NOT_CONFIGURED|STALE|PAIR_UNKNOWN|PAIR_PAUSED|NO_SOURCES|DEVIATION|INSUFFICIENT_SOURCES|UNAVAILABLE)\b/.test(msg);
}

/**
 * v0.5.3: run one oracle check under the signed unavailable policy. `check`
 * returns the quote it used (and throws ORACLE_POLICY_REJECTED when out of
 * band, which always rejects). Without a gate the oracle counts as unavailable.
 */
export function runOracleCheck(gate: OraclePolicyGate | undefined, policy: OracleUnavailablePolicy | undefined, height: number, check: (gate: OraclePolicyGate) => AggregatedQuote): OracleCheckRecord {
  const onUnavailable = policy ?? DEFAULT_ON_ORACLE_UNAVAILABLE;
  try {
    if (!gate) throw new Error("ORACLE_NOT_CONFIGURED: no oracle gate");
    const q = check(gate);
    return { outcome: "IN_BAND", height, quoteHash: aggregatedQuoteHash(q) };
  } catch (err) {
    if (!isOracleUnavailableError(err)) throw err;
    if (onUnavailable === "BLOCK_NEW") throw err;
    return { outcome: "ORACLE_UNAVAILABLE_SIGNED_PRICE", height, reason: (err as Error).message.split(":")[0]! };
  }
}

export function assertOracleReferenceTerms(t: unknown): OracleReferenceTerms {
  const r = t as OracleReferenceTerms;
  if (!r || typeof r.baseAssetId !== "string" || typeof r.baseUnitsPerQuantity !== "bigint" || r.baseUnitsPerQuantity <= 0n || typeof r.maxDeviationPpm !== "bigint" || r.maxDeviationPpm < 0n || r.maxDeviationPpm > MAX_ORACLE_DEVIATION_PPM) {
    throw new Error("ORACLE_REFERENCE_INVALID");
  }
  const onOracleUnavailable = assertOracleUnavailablePolicy(r.onOracleUnavailable);
  return { baseAssetId: r.baseAssetId, baseUnitsPerQuantity: r.baseUnitsPerQuantity, maxDeviationPpm: r.maxDeviationPpm, ...(onOracleUnavailable ? { onOracleUnavailable } : {}) };
}

export class OraclePolicyGate {
  readonly aggregator: OracleAggregator;

  constructor(aggregator: OracleAggregator) {
    if (!aggregator || typeof aggregator.read !== "function") throw new Error("ORACLE_GATE_INVALID");
    if (!aggregator.policy.requireSignatures) throw new Error("ORACLE_GATE_UNSIGNED: the gate needs an aggregator with requireSignatures");
    this.aggregator = aggregator;
  }

  /** Aggregated quote or ORACLE_<code> (fail closed). */
  quote(baseAssetId: string, quoteAssetId: string, height: number): AggregatedQuote {
    const r = this.aggregator.read(baseAssetId, quoteAssetId, height);
    if (!r.ok) throw new Error(`ORACLE_${r.code}: ${r.message}`);
    return r.quote;
  }

  /**
   * True when the registry has a pair policy for base/quote. Informational
   * only (v0.5.3): no path uses it to decide whether the oracle is required.
   */
  governs(baseAssetId: string, quoteAssetId: string): boolean {
    return this.aggregator.registry.getPairPolicy(baseAssetId, quoteAssetId) !== undefined;
  }

  /** Oracle price of one listing quantity in the listing asset (floor). */
  referenceUnitPrice(terms: OracleReferenceTerms, asset: string, height: number): { unitPrice: bigint; quote: AggregatedQuote } {
    const q = this.quote(terms.baseAssetId, asset, height);
    return { unitPrice: (q.priceE6 * terms.baseUnitsPerQuantity) / PRICE_SCALE, quote: q };
  }

  /** Marketplace: listing price within the signed deviation band of the oracle reference. */
  assertServicePrice(terms: OracleReferenceTerms, asset: string, unitPrice: bigint, height: number): AggregatedQuote {
    const { unitPrice: ref, quote } = this.referenceUnitPrice(terms, asset, height);
    if (ref <= 0n) throw new Error("ORACLE_POLICY_REJECTED: oracle reference price is zero");
    const diff = unitPrice > ref ? unitPrice - ref : ref - unitPrice;
    const ppm = (diff * PPM_SCALE) / ref;
    if (ppm > terms.maxDeviationPpm) throw new Error(`ORACLE_POLICY_REJECTED: unit price ${unitPrice} deviates ${ppm} PPM from the oracle reference ${ref} (limit ${terms.maxDeviationPpm})`);
    return quote;
  }

  /**
   * IoT: the request's gross amount is within the band and, when the buyer
   * gives a budget, the oracle cost of the delivered base units fits it
   * (evaluateIotTariff).
   */
  assertIotTariff(terms: OracleReferenceTerms, asset: string, unitPrice: bigint, quantity: bigint, height: number, maxCost?: bigint): EconomicEvaluation {
    const quote = this.assertServicePrice(terms, asset, unitPrice, height);
    const budget = maxCost ?? quantity * unitPrice + (quantity * unitPrice * terms.maxDeviationPpm) / PPM_SCALE;
    const evaluation = evaluateIotTariff(quote, quantity * terms.baseUnitsPerQuantity, budget, height);
    if (evaluation.decision !== "ACCEPTED") throw new Error(`ORACLE_POLICY_REJECTED: ${evaluation.reason}`);
    return evaluation;
  }

  /** Hashlock swap: the implied rate toAmount/fromAmount is within `maxSkewPpm` of the oracle rate from→to. */
  assertSwapRate(fromAsset: string, fromAmount: bigint, toAsset: string, toAmount: bigint, height: number, maxSkewPpm: bigint): AggregatedQuote {
    const quote = this.quote(fromAsset, toAsset, height);
    const r = verifyAmmSpotSkew(fromAmount, toAmount, quote, true, maxSkewPpm);
    if (!r.ok) throw new Error(`ORACLE_POLICY_REJECTED: ${r.message}`);
    return quote;
  }
}
