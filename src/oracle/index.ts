/**
 * Oracle aggregator (v0.5.2). Register → verify → anti-replay → aggregate.
 * Policy evaluation only; never moves funds. Heights (ADR 0002).
 */
import { DEFAULT_ORACLE_POLICY, PPM_SCALE } from "./types.ts";
import type { OraclePolicy, OracleQuote, OracleReject, SignedOracleQuote } from "./types.ts";
import { OracleRegistry } from "./registry.ts";
import { OracleVerifier } from "./verifier.ts";
import { publicKeyHexOf } from "../core/ed25519.ts";

export * from "./types.ts";
export * from "./canonical.ts";
export * from "./registry.ts";
export * from "./verifier.ts";
export * from "./risk-policy.ts";
export * from "./policy-gate.ts";

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
    // v0.5.3: an unverified quote never enters a feed of a signature-checking aggregator.
    if (this.policy.requireSignatures) throw new Error("ORACLE_PUBLISH_SYNC_REFUSED: requireSignatures is on; use publish()");
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

    // v0.5.3: only quotes of sources that are registered ACTIVE now, signed with their current key,
    // count (a revoked or suspended source, or a rotated-out key, stops counting immediately).
    const current = list.filter((q) => this.countsNow(q));
    const freshAll = current.filter((q) => height - q.observedAtHeight <= maxStaleness);
    if (freshAll.length === 0) {
      return {
        ok: false,
        code: current.length === 0 ? "NO_SOURCES" : "STALE",
        message: current.length === 0
          ? `No quote of an active source with its current key for '${baseAssetId}/${quoteAssetId}'.`
          : `All oracle quotes for '${baseAssetId}/${quoteAssetId}' are stale (older than ${maxStaleness} heights).`,
      };
    }

    // v0.5.3 (V-1): independent sources are counted by key, not by source id.
    const deduped = this.dedupeByKey(freshAll);
    if (deduped.length < minSources) {
      return {
        ok: false,
        code: "NO_SOURCES",
        message: `Insufficient independent sources: requires ≥ ${minSources}, but only ${deduped.length} fresh source(s) available.`,
      };
    }

    // v0.5.3: an outlier is dropped on its own instead of rejecting the whole feed. Sources farther
    // than the pair band from the weighted median of all fresh sources are left out; the feed is
    // usable while at least minSources remain and those agree within the band. With two sources
    // that disagree beyond the band no outlier can be told apart: DEVIATION (oracle unavailable).
    const all = [...deduped].sort((a, b) => (a.priceE6 < b.priceE6 ? -1 : a.priceE6 > b.priceE6 ? 1 : 0));
    const center = this.policy.useWeightedMedian ? this.computeWeightedMedian(all) : all[Math.floor(all.length / 2)]!.priceE6;
    if (center <= 0n) return { ok: false, code: "DEVIATION", message: "Oracle median price is not positive." };
    const within = (p: bigint) => ((p > center ? p - center : center - p) * PPM_SCALE) / center <= maxDevPpm;
    const sorted = all.filter((q) => within(q.priceE6));
    const fresh = sorted;
    if (sorted.length < minSources) {
      return {
        ok: false,
        code: "DEVIATION",
        message: `Only ${sorted.length} source(s) within ${maxDevPpm} PPM of the median; requires ≥ ${minSources}.`,
      };
    }
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

  /** v0.5.3: the quote's source is registered ACTIVE and the quote is signed with its current key (when signed). */
  private countsNow(q: OracleQuote | SignedOracleQuote): boolean {
    const reg = this.registry.getSource(q.source);
    if (!reg) return !this.policy.requireSignatures;
    if (reg.status !== "ACTIVE") return false;
    const signer = (q as SignedOracleQuote).signerPublicKeyHex;
    if (signer !== undefined) {
      try { return publicKeyHexOf(signer) === reg.publicKeyHex; } catch { return false; }
    }
    return !this.policy.requireSignatures;
  }

  /** One quote per signing key (registered key, else the quote's signer key, else the source id); the latest observation wins. */
  private dedupeByKey(quotes: (OracleQuote | SignedOracleQuote)[]): (OracleQuote | SignedOracleQuote)[] {
    const byKey = new Map<string, OracleQuote | SignedOracleQuote>();
    for (const q of quotes) {
      const k = this.registry.getSource(q.source)?.publicKeyHex ?? (q as SignedOracleQuote).signerPublicKeyHex ?? `source:${q.source}`;
      const prev = byKey.get(k);
      if (!prev || q.observedAtHeight > prev.observedAtHeight || (q.observedAtHeight === prev.observedAtHeight && q.sequence > prev.sequence)) byKey.set(k, q);
    }
    return [...byKey.values()];
  }

  /**
   * Effective weights (v0.5.3, V-4): each source's administrative weight is
   * capped so that it carries strictly less than `maxSourceWeightSharePpm` of
   * the total (default one half), so no single key decides the median alone:
   * cap_i = floor((others_i * share - 1) / (1 - share)), at least 1.
   */
  effectiveWeights(weights: readonly number[]): bigint[] {
    const share = this.policy.maxSourceWeightSharePpm;
    if (share <= 0n || share > PPM_SCALE) throw new Error("ORACLE_WEIGHT_SHARE_INVALID");
    const w = weights.map((x) => BigInt(Math.max(1, Math.trunc(x))));
    const total = w.reduce((a, b) => a + b, 0n);
    if (share === PPM_SCALE || w.length < 2) return w;
    return w.map((x) => {
      const cap = ((total - x) * share - 1n) / (PPM_SCALE - share);
      return x > cap ? (cap < 1n ? 1n : cap) : x;
    });
  }

  private computeWeightedMedian(sortedQuotes: (OracleQuote | SignedOracleQuote)[]): bigint {
    const raw = sortedQuotes.map((q) => {
      const reg = this.registry.getSource(q.source);
      return reg && reg.status === "ACTIVE" ? Math.max(1, reg.weight) : 1;
    });
    const weights = this.effectiveWeights(raw);
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    // Weighted median: first price where the accumulated weight reaches half. v0.5.3: at an exact
    // half split (e.g. two sources of equal effective weight) the result is the floor of the mean of
    // the two middle prices, so neither the lower nor the higher quote wins by position.
    let accumulated = 0n;
    for (const [i, q] of sortedQuotes.entries()) {
      accumulated += weights[i]!;
      if (2n * accumulated === totalWeight && i + 1 < sortedQuotes.length) return (q.priceE6 + sortedQuotes[i + 1]!.priceE6) / 2n;
      if (2n * accumulated >= totalWeight) return q.priceE6;
    }
    return sortedQuotes[Math.floor(sortedQuotes.length / 2)]!.priceE6;
  }
}
export { isValidLei, leiCheckDigits } from "./lei.ts";
