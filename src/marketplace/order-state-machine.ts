/**
 * 0.5.81 item 6: the marketplace order state machine, written down as data.
 *
 * Phases (the findings' HOLD -> EXECUTION -> EVIDENCE -> SETTLEMENT):
 *   HOLD       ACCEPTED (deposit locked), HELD (full escrow held)
 *   EXECUTION  provider works while HELD; the phase ends with deliver()
 *   EVIDENCE   DELIVERED (delivery hash recorded), DISPUTED (evidence under review)
 *   SETTLEMENT SETTLED / REFUNDED (only through the settlement engine, with a receipt hash)
 *   CLOSED     CANCELLED / EXPIRED (no settlement; deposit/escrow returned or forfeited)
 *
 * Every status write in DigitalServicesMarketplace goes through assertOrderTransition().
 * Time is block height only (reservation expiry, dispute deadline).
 */
import type { OrderStatus } from "./marketplace.ts";

export type OrderPhase = "HOLD" | "EVIDENCE" | "SETTLEMENT" | "CLOSED";

export const ORDER_PHASE: Readonly<Record<OrderStatus, OrderPhase>> = Object.freeze({
  ACCEPTED: "HOLD", HELD: "HOLD", DELIVERED: "EVIDENCE", DISPUTED: "EVIDENCE",
  SETTLED: "SETTLEMENT", REFUNDED: "SETTLEMENT", CANCELLED: "CLOSED", EXPIRED: "CLOSED",
});

/** Allowed transitions. Terminal states have none. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  ACCEPTED: ["HELD", "CANCELLED", "EXPIRED"],
  HELD: ["DELIVERED", "CANCELLED", "EXPIRED"],
  DELIVERED: ["DISPUTED", "SETTLED", "REFUNDED"],
  DISPUTED: ["SETTLED", "REFUNDED"],
  SETTLED: [], REFUNDED: [], CANCELLED: [], EXPIRED: [],
});

export function isTerminalOrderStatus(s: OrderStatus): boolean { return ORDER_TRANSITIONS[s].length === 0; }

export function assertOrderTransition(from: OrderStatus, to: OrderStatus, ctx: { settlementReceiptHash?: string } = {}): void {
  if (!ORDER_TRANSITIONS[from]?.includes(to)) throw new Error(`ORDER_TRANSITION_INVALID:${from}->${to}`);
  if (ORDER_PHASE[to] === "SETTLEMENT" && !ctx.settlementReceiptHash) throw new Error("SETTLEMENT_RECEIPT_REQUIRED");
}
