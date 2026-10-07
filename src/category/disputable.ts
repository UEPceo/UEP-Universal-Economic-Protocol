/**
 * Contract between the category dispute engine and swap / relay (v0.5.2).
 * Verdicts are releaseBps: 10000 = RELEASE, 0 = REFUND_BUYER, between = SPLIT.
 * Escrow amounts are bigint.
 */
/**
 * v0.5.3: maximum duration of a dispute freeze, in heights (241_920 = 14 days
 * at the reference block time). A freeze older than this lapses: the order's
 * own refund / timeout path opens again (swap expire, relay expire or
 * finalize), whatever happened to the dispute. A dispute engine must be able
 * to time out before that (evidence + resolution heights <= this cap).
 */
export const MAX_FREEZE_HEIGHTS = 241_920;

/** v0.5.3: true once a freeze started at `frozenAt` is older than MAX_FREEZE_HEIGHTS at `height`. */
export function freezeLapsed(frozenAt: number | undefined, height: number): boolean {
  return frozenAt !== undefined && height - frozenAt > MAX_FREEZE_HEIGHTS;
}

export interface DisputeCap {
  readonly kind: "dispute-cap";
}

export interface EscrowView {
  orderId: string;
  category: "swap" | "relay";
  buyerId: string;
  sellerId: string;
  buyerSide: string[];
  sellerSide: string[];
  escrows: { asset: string; amount: bigint }[];
  open: boolean;
  frozen: boolean;
}

export interface Disputable {
  readonly category: "swap" | "relay";
  issueDisputeCap(): DisputeCap;
  escrowView(orderId: string): EscrowView | undefined;
  freeze(cap: DisputeCap, orderId: string, caseId: string): void;
  unfreeze(cap: DisputeCap, orderId: string, caseId: string): void;
  apply(cap: DisputeCap, orderId: string, caseId: string, releaseBps: number): void;
  /**
   * v0.5.3 (V52-01): category-specific outcome when a dispute times out with
   * no verdict. "resume" = unfreeze the order and let its own objective rules
   * (e.g. relay fraud window, then finalize) decide; a number = releaseBps to
   * apply; undefined = the dispute engine's defaultReleaseBps.
   */
  timeoutOutcome?(orderId: string): "resume" | number | undefined;
}

export function newDisputeCapRegistry(): { issue(): DisputeCap; check(cap: DisputeCap): void } {
  let issued: DisputeCap | undefined;
  return {
    issue() {
      if (issued) throw new Error("DISPUTE_CAP_ALREADY_ISSUED");
      issued = Object.freeze({ kind: "dispute-cap" as const });
      return issued;
    },
    check(cap) {
      if (cap !== issued) throw new Error("DISPUTE_CAP_INVALID");
    },
  };
}
