/**
 * v0.5.3 oracle policy gate: the single place where Marketplace listings,
 * IoT tariffs and hashlock swaps consult the oracle. Pure and synchronous: it
 * reads the aggregator at the caller's height (ADR 0002) and throws
 * ORACLE_* errors; it never moves funds and holds no balance.
 *
 * Fail closed: when a path is bound to the oracle (a listing with
 * `oracleReference`, an IoT service with `requireOracleTariff`, a swap pair
 * with a pair policy or `requireOracle`), a missing, stale, paused, deviating
 * or under-sourced feed rejects the operation.
 *
 * Prices are always between two concrete assets (no reference unit, no
 * common currency): `priceE6` is quote-asset units per base-asset unit × 10^6.
 */
import { PPM_SCALE, PRICE_SCALE, type AggregatedQuote, type EconomicEvaluation } from "./types.ts";
import type { OracleAggregator } from "./index.ts";
import { evaluateIotTariff, verifyAmmSpotSkew } from "./risk-policy.ts";

/**
 * Oracle terms of a listing (signed with the listing terms): the listing's
 * `unitPrice` (in the listing asset) must stay within `maxDeviationPpm` of
 * `baseUnitsPerQuantity` units of `baseAssetId` priced by the oracle in the
 * listing asset.
 */
export type OracleReferenceTerms = { baseAssetId: string; baseUnitsPerQuantity: bigint; maxDeviationPpm: bigint };

export const MAX_ORACLE_DEVIATION_PPM = 500_000n;

export function assertOracleReferenceTerms(t: unknown): OracleReferenceTerms {
  const r = t as OracleReferenceTerms;
  if (!r || typeof r.baseAssetId !== "string" || typeof r.baseUnitsPerQuantity !== "bigint" || r.baseUnitsPerQuantity <= 0n || typeof r.maxDeviationPpm !== "bigint" || r.maxDeviationPpm < 0n || r.maxDeviationPpm > MAX_ORACLE_DEVIATION_PPM) {
    throw new Error("ORACLE_REFERENCE_INVALID");
  }
  return { baseAssetId: r.baseAssetId, baseUnitsPerQuantity: r.baseUnitsPerQuantity, maxDeviationPpm: r.maxDeviationPpm };
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

  /** True when the registry has a pair policy for base/quote (the pair is oracle-governed). */
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
