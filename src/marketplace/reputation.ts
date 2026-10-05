/** Reputation and seller-integrity primitives for the UEP marketplace. */
import { HEIGHTS_PER_DAY } from "../core/height.ts";
import { looksLikeLegacyMs } from "../core/deprecation.ts";

export type ReputationEvent = {
  sellerId: string;
  buyerId: string;
  orderId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  settledAmount: bigint;
  sellerBond: bigint;
  createdAt: number;
};

export type SellerReputation = {
  sellerId: string;
  score: number;
  effectiveReviews: number;
  settledVolume: bigint;
  bondedAmount: bigint;
  accountAgeDays: number;
};

/** Latest `createdAt` of the events (0 without events): the deterministic default for `now`. */
export function latestEventTick(events: readonly ReputationEvent[]): number {
  return events.reduce((m, e) => (e.createdAt > m ? e.createdAt : m), 0);
}

/** Ticks per day for a set of events: Unix-ms stamps (pre-v0.5.1) use 86,400,000, heights HEIGHTS_PER_DAY. */
export function defaultTicksPerDay(events: readonly ReputationEvent[], now?: number): number {
  return looksLikeLegacyMs(now) || (now === undefined && events.some((e) => looksLikeLegacyMs(e.createdAt))) ? 86_400_000 : HEIGHTS_PER_DAY;
}

/**
 * Bayesian shrinkage prevents tiny, collusive samples from immediately reaching 5/5.
 * v0.5.1 (ADR 0002): `now` and `createdAt` are heights; `ticksPerDay` converts
 * them to days. Compatibility defaults (no clock is read): `now` is the
 * latest event stamp, and `ticksPerDay` is 86,400,000 for Unix-ms stamps
 * (callers before v0.5.1), else HEIGHTS_PER_DAY.
 */
export function calculateBayesianReputation(
  events: ReputationEvent[],
  sellerId: string,
  now: number = latestEventTick(events),
  priorMean = 3.5,
  priorWeight = 8,
  ticksPerDay: number = defaultTicksPerDay(events, now),
): SellerReputation {
  const rows = events.filter((e) => e.sellerId === sellerId);
  const settledVolume = rows.reduce((n, e) => n + e.settledAmount, 0n);
  const bondedAmount = rows.reduce((n, e) => n > e.sellerBond ? n : e.sellerBond, 0n);
  const weighted = rows.reduce((n, e) => {
    const ageDays = Math.max(1, (now - e.createdAt) / ticksPerDay);
    const volumeWeight = Math.max(1, Math.log10(Number(e.settledAmount > 0n ? e.settledAmount : 1n)) + 1);
    const ageWeight = Math.min(1, ageDays / 30);
    const bondWeight = e.sellerBond > 0n ? 1.25 : 0.75;
    return n + e.rating * volumeWeight * Math.max(0.25, ageWeight) * bondWeight;
  }, 0);
  const sampleWeight = rows.reduce((n, e) => {
    const volumeWeight = Math.max(1, Math.log10(Number(e.settledAmount > 0n ? e.settledAmount : 1n)) + 1);
    const ageDays = Math.max(1, (now - e.createdAt) / ticksPerDay);
    return n + volumeWeight * Math.max(0.25, Math.min(1, ageDays / 30)) * (e.sellerBond > 0n ? 1.25 : 0.75);
  }, 0);
  const score = (priorMean * priorWeight + weighted) / (priorWeight + sampleWeight);
  return { sellerId, score, effectiveReviews: rows.length, settledVolume, bondedAmount, accountAgeDays: rows.length ? Math.max(...rows.map((e) => Math.max(0, (now - e.createdAt) / ticksPerDay))) : 0 };
}

export class MarketplaceReputation {
  private readonly events: ReputationEvent[] = [];
  private readonly ratedOrders = new Set<string>();

  record(event: ReputationEvent): void {
    if (!event.sellerId || !event.buyerId || !event.orderId) throw new Error("REPUTATION_METADATA_REQUIRED");
    if (event.buyerId === event.sellerId) throw new Error("SELF_REVIEW_FORBIDDEN");
    if (this.ratedOrders.has(event.orderId)) throw new Error("ORDER_ALREADY_RATED");
    if (event.settledAmount <= 0n) throw new Error("REVIEW_REQUIRES_SETTLEMENT");
    this.events.push(event);
    this.ratedOrders.add(event.orderId);
  }

  /**
   * `now` is the current height (or tick); `ticksPerDay` its ticks per day.
   * Without `now` (pre-v0.5.1 callers): the latest recorded event stamp, so
   * the result is deterministic; see calculateBayesianReputation().
   */
  score(sellerId: string, now?: number, ticksPerDay?: number): SellerReputation {
    const at = now ?? latestEventTick(this.events);
    return calculateBayesianReputation(this.events, sellerId, at, 3.5, 8, ticksPerDay ?? defaultTicksPerDay(this.events, now));
  }

  listEvents(): readonly ReputationEvent[] { return [...this.events]; }
}
