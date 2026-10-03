/**
 * UEP oracle layer — external price / unit conversion feeds.
 *
 * Design goals (UEP multi-asset, no native coin):
 * - Oracles report ratios between registered assets (e.g. tEUR per tENERGY).
 * - Consensus does **not** require live oracle data for basic spends.
 * - Liquidity / risk modules may require fresh quotes.
 *
 * Status: IMPLEMENTED simulated aggregator for TESTNET.
 * Live external attestations: CONCEPTUAL.
 */

export type OracleQuote = {
  /** Base asset id (what you hold). */
  baseAssetId: string;
  /** Quote asset id (price unit). */
  quoteAssetId: string;
  /**
   * Price as rational: `base * priceNum / priceDen = quote` in base units
   * after accounting for decimals externally. Here we use integer fixed-point
   * with scale 1e6 (PRICE_SCALE).
   */
  priceE6: bigint;
  /** Source identifier (feed name). */
  source: string;
  /** Unix ms when the source observed the price. */
  observedAtMs: number;
  /** Optional cryptographic attestation payload (hex) — CONCEPTUAL. */
  attestation?: string;
};

export const PRICE_SCALE = 1_000_000n;

export type OracleReject =
  | { ok: false; code: "STALE" | "DEVIATION" | "NO_SOURCES" | "PAIR_UNKNOWN"; message: string }
  | { ok: true; quote: AggregatedQuote };

export type AggregatedQuote = {
  baseAssetId: string;
  quoteAssetId: string;
  priceE6: bigint;
  sourcesUsed: number;
  minPriceE6: bigint;
  maxPriceE6: bigint;
  observedAtMs: number;
  aggregatedAtMs: number;
};

export type OraclePolicy = {
  /** Max age of a quote in ms. */
  maxStalenessMs: number;
  /** Max relative deviation among sources in parts-per-million before reject. */
  maxDeviationPpm: bigint;
  /** Minimum independent sources required. */
  minSources: number;
};

const DEFAULT_POLICY: OraclePolicy = {
  maxStalenessMs: 60_000,
  maxDeviationPpm: 50_000n, // 5%
  minSources: 1,
};

export class OracleAggregator {
  policy: OraclePolicy;
  /** key = `${base}|${quote}` → quotes */
  private feeds = new Map<string, OracleQuote[]>();

  constructor(policy: Partial<OraclePolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  private key(base: string, quote: string) {
    return `${base}|${quote}`;
  }

  /** Replace all quotes for a pair from one source. */
  publish(quote: OracleQuote) {
    const k = this.key(quote.baseAssetId, quote.quoteAssetId);
    const list = this.feeds.get(k) ?? [];
    const next = list.filter((q) => q.source !== quote.source);
    next.push(quote);
    this.feeds.set(k, next);
  }

  clear() {
    this.feeds.clear();
  }

  /**
   * Aggregate median price with staleness + deviation checks.
   */
  read(baseAssetId: string, quoteAssetId: string, nowMs = Date.now()): OracleReject {
    const list = this.feeds.get(this.key(baseAssetId, quoteAssetId)) ?? [];
    const fresh = list.filter((q) => nowMs - q.observedAtMs <= this.policy.maxStalenessMs);
    if (fresh.length === 0) {
      return {
        ok: false,
        code: list.length === 0 ? "PAIR_UNKNOWN" : "STALE",
        message:
          list.length === 0
            ? "No oracle sources for this pair."
            : "All oracle quotes are stale.",
      };
    }
    if (fresh.length < this.policy.minSources) {
      return {
        ok: false,
        code: "NO_SOURCES",
        message: `Need ≥ ${this.policy.minSources} sources, have ${fresh.length}.`,
      };
    }
    const prices = fresh.map((q) => q.priceE6).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const min = prices[0]!;
    const max = prices[prices.length - 1]!;
    if (min > 0n) {
      const devPpm = ((max - min) * 1_000_000n) / min;
      if (devPpm > this.policy.maxDeviationPpm) {
        return {
          ok: false,
          code: "DEVIATION",
          message: `Source deviation ${devPpm} ppm exceeds policy ${this.policy.maxDeviationPpm}.`,
        };
      }
    }
    const mid = prices[Math.floor(prices.length / 2)]!;
    const observedAtMs = Math.min(...fresh.map((q) => q.observedAtMs));
    return {
      ok: true,
      quote: {
        baseAssetId,
        quoteAssetId,
        priceE6: mid,
        sourcesUsed: fresh.length,
        minPriceE6: min,
        maxPriceE6: max,
        observedAtMs,
        aggregatedAtMs: nowMs,
      },
    };
  }
}

/**
 * Deterministic simulated feeds for TESTNET demos (not live markets).
 */
export function seedTestnetOracles(agg: OracleAggregator, nowMs = Date.now()) {
  const pairs: Array<[string, string, bigint, string]> = [
    ["uep-test/tenergy", "uep-test/teur", 120_000n, "sim-feed-a"], // 0.12 tEUR / energy
    ["uep-test/tenergy", "uep-test/teur", 121_000n, "sim-feed-b"],
    ["uep-test/tbtc", "uep-test/teur", 60_000_000_000n, "sim-feed-a"], // 60k tEUR / tBTC (e6)
    ["uep-test/tdata", "uep-test/teur", 50_000n, "sim-feed-a"],
  ];
  for (const [base, quote, priceE6, source] of pairs) {
    agg.publish({
      baseAssetId: base,
      quoteAssetId: quote,
      priceE6,
      source,
      observedAtMs: nowMs,
    });
  }
}

export const defaultOracle = new OracleAggregator();
