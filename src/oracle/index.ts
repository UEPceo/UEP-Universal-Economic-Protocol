/**
 * Oracle aggregator (v0.5.2). Register → verify → anti-replay → aggregate.
 * Policy evaluation only; never moves funds. Heights (ADR 0002).
 */
import { DEFAULT_ORACLE_POLICY, PPM_SCALE } from "./types.ts";
import type { OraclePolicy, OracleQuote, OracleReject, SignedOracleQuote } from "./types.ts";
import { OracleRegistry } from "./registry.ts";
import { OracleVerifier } from "./verifier.ts";

export * from "./types.ts";
export * from "./canonical.ts";
export * from "./registry.ts";
export * from "./verifier.ts";
export * from "./risk-policy.ts";

export class OracleAggregator {
  readonly policy: OraclePolicy;
  readonly registry: OracleRegistry;
  readonly verifier: OracleVerifier;
  private feeds = new Map<string, (OracleQuote | SignedOracleQuote)[]>();

  constructor(policy: Partial<OraclePolicy> = {}, registry?: OracleRegistry) {
    this.policy = { ...DEFAULT_ORACLE_POLICY, ...policy };
    this.registry = registry ?? new OracleRegistry();
    this.verifier = new OracleVerifier(this.registry);
  }

  private key(base: string, quote: string): string {
    return `${base}|${quote}`;
  }

  /** Publish a quote after cryptographic and semantic verification at `height`. */
  publish(
    quote: OracleQuote | SignedOracleQuote,
    height: number,
  ): { ok: boolean; code?: string; message?: string } {
    const check = this.verifier.verifyQuote(quote, this.policy, height);
    if (!check.ok) return check;

    const verifiedQuote = check.verifiedQuote;
    const k = this.key(quote.baseAssetId, quote.quoteAssetId);
    const list = this.feeds.get(k) ?? [];
    const next = list.filter((q) => q.source !== quote.source);
    next.push(verifiedQuote);
    this.feeds.set(k, next);

    this.registry.touchSource(quote.source, height);
    return { ok: true };
  }

  /**
   * Testnet helper: store a quote as VERIFIED without signature checks.
   * Production paths must use publish() with requireSignatures.
   */
  publishSync(quote: OracleQuote): void {
    const k = this.key(quote.baseAssetId, quote.quoteAssetId);
    const list = this.feeds.get(k) ?? [];
    const next = list.filter((q) => q.source !== quote.source);
    next.push({ ...quote, stage: "VERIFIED" });
    this.feeds.set(k, next);
  }

  clear(): void {
    this.feeds.clear();
    this.verifier.clearSequenceCache();
  }

  read(baseAssetId: string, quoteAssetId: string, height: number): OracleReject {
    if (!Number.isSafeInteger(height) || height < 0) {
      return { ok: false, code: "INVALID_TIMESTAMP", message: "height must be a non-negative safe integer" };
    }
    if (this.registry.isPairPaused(baseAssetId, quoteAssetId)) {
      return {
        ok: false,
        code: "PAIR_PAUSED",
        message: `Oracle feed for ${baseAssetId}/${quoteAssetId} is paused by risk policy.`,
      };
    }

    const pairPolicy = this.registry.getPairPolicy(baseAssetId, quoteAssetId);
    const maxStaleness = pairPolicy?.maxStalenessHeights ?? this.policy.defaultMaxStalenessHeights;
    const minSources = pairPolicy?.minSources ?? this.policy.defaultMinSources;
    const maxDevPpm = pairPolicy?.maxDeviationPpm ?? this.policy.defaultMaxDeviationPpm;

    const list = this.feeds.get(this.key(baseAssetId, quoteAssetId)) ?? [];
    if (list.length === 0) {
      return {
        ok: false,
        code: "PAIR_UNKNOWN",
        message: `No active oracle sources published for pair '${baseAssetId}/${quoteAssetId}'.`,
      };
    }

    const fresh = list.filter((q) => height - q.observedAtHeight <= maxStaleness);
    if (fresh.length === 0) {
      return {
        ok: false,
        code: "STALE",
        message: `All oracle quotes for '${baseAssetId}/${quoteAssetId}' are stale (older than ${maxStaleness} heights).`,
      };
    }

    if (fresh.length < minSources) {
      return {
        ok: false,
        code: "NO_SOURCES",
        message: `Insufficient independent sources: requires ≥ ${minSources}, but only ${fresh.length} fresh source(s) available.`,
      };
    }

    const sorted = [...fresh].sort((a, b) => (a.priceE6 < b.priceE6 ? -1 : a.priceE6 > b.priceE6 ? 1 : 0));
    const minPrice = sorted[0]!.priceE6;
    const maxPrice = sorted[sorted.length - 1]!.priceE6;

    if (minPrice > 0n) {
      const devPpm = ((maxPrice - minPrice) * PPM_SCALE) / minPrice;
      if (devPpm > maxDevPpm) {
        return {
          ok: false,
          code: "DEVIATION",
          message: `Source deviation ${devPpm} PPM exceeds pair policy limit ${maxDevPpm} PPM.`,
        };
      }
    }

    const consolidatedPrice = this.policy.useWeightedMedian
      ? this.computeWeightedMedian(sorted)
      : sorted[Math.floor(sorted.length / 2)]!.priceE6;

    const observedAtHeight = Math.min(...fresh.map((q) => q.observedAtHeight));
    const sharedContextId = fresh.every((q) => q.contextId === fresh[0]?.contextId) ? fresh[0]?.contextId : undefined;

    return {
      ok: true,
      quote: {
        stage: "AGGREGATED",
        baseAssetId,
        quoteAssetId,
        priceE6: consolidatedPrice,
        sourcesUsed: fresh.length,
        minPriceE6: minPrice,
        maxPriceE6: maxPrice,
        observedAtHeight,
        aggregatedAtHeight: height,
        contextId: sharedContextId,
        sources: fresh.map((q) => {
          const reg = this.registry.getSource(q.source);
          return {
            source: q.source,
            priceE6: q.priceE6,
            observedAtHeight: q.observedAtHeight,
            weight: reg && reg.status === "ACTIVE" ? reg.weight : 1,
          };
        }),
      },
    };
  }

  private computeWeightedMedian(sortedQuotes: (OracleQuote | SignedOracleQuote)[]): bigint {
    const items = sortedQuotes.map((q) => {
      const reg = this.registry.getSource(q.source);
      const weight = reg && reg.status === "ACTIVE" ? Math.max(1, reg.weight) : 1;
      return { priceE6: q.priceE6, weight };
    });
    const totalWeight = items.reduce((acc, curr) => acc + curr.weight, 0);
    const halfWeight = totalWeight / 2;
    let accumulated = 0;
    for (const item of items) {
      accumulated += item.weight;
      if (accumulated >= halfWeight) return item.priceE6;
    }
    return items[Math.floor(items.length / 2)]!.priceE6;
  }
}
