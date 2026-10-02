/** Reputation and seller-integrity primitives for the UEP marketplace. */

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

/** Bayesian shrinkage prevents tiny, collusive samples from immediately reaching 5/5. */
export function calculateBayesianReputation(
  events: ReputationEvent[],
  sellerId: string,
  now = Date.now(),
  priorMean = 3.5,
  priorWeight = 8,
): SellerReputation {
  const rows = events.filter((e) => e.sellerId === sellerId);
  const settledVolume = rows.reduce((n, e) => n + e.settledAmount, 0n);
  const bondedAmount = rows.reduce((n, e) => n > e.sellerBond ? n : e.sellerBond, 0n);
  const weighted = rows.reduce((n, e) => {
    const ageDays = Math.max(1, (now - e.createdAt) / 86_400_000);
    const volumeWeight = Math.max(1, Math.log10(Number(e.settledAmount > 0n ? e.settledAmount : 1n)) + 1);
    const ageWeight = Math.min(1, ageDays / 30);
    const bondWeight = e.sellerBond > 0n ? 1.25 : 0.75;
    return n + e.rating * volumeWeight * Math.max(0.25, ageWeight) * bondWeight;
  }, 0);
  const sampleWeight = rows.reduce((n, e) => {
    const volumeWeight = Math.max(1, Math.log10(Number(e.settledAmount > 0n ? e.settledAmount : 1n)) + 1);
    const ageDays = Math.max(1, (now - e.createdAt) / 86_400_000);
    return n + volumeWeight * Math.max(0.25, Math.min(1, ageDays / 30)) * (e.sellerBond > 0n ? 1.25 : 0.75);
  }, 0);
  const score = (priorMean * priorWeight + weighted) / (priorWeight + sampleWeight);
  return { sellerId, score, effectiveReviews: rows.length, settledVolume, bondedAmount, accountAgeDays: rows.length ? Math.max(...rows.map((e) => Math.max(0, (now - e.createdAt) / 86_400_000))) : 0 };
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

  score(sellerId: string, now = Date.now()): SellerReputation {
    return calculateBayesianReputation(this.events, sellerId, now);
  }

  listEvents(): readonly ReputationEvent[] { return [...this.events]; }
}
