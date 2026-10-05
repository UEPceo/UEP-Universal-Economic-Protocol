/**
 * Types of the v0.5.2 settlement engine (src/settlement/engine.ts).
 *
 * The engine is the single payout executor behind the Marketplace: it closes
 * one escrow into provider net, Marketplace fee, captured gas and buyer
 * refund. Order state (status, capacity, deadlines, guards, signatures) stays
 * with the Marketplace or the category module that owns the escrow.
 *
 * Status: IMPLEMENTED (testnet reference). Business-layer accounting only; no
 * native token, no consensus finality.
 */

export const SETTLEMENT_RECEIPT_VERSION = "uep-settlement-receipt-v1" as const;
export const SETTLEMENT_RECEIPT_DOMAIN = "UEP-SETTLEMENT-RECEIPT-v1" as const;

export type SettlementOutcome = "RELEASE" | "REFUND_BUYER" | "SPLIT";

/** What to pay out of one escrow. All amounts are bigint (ADR 0001). */
export type PayoutInstruction = {
  /** Unique id of this settlement: the fee is settled once per id and the receipt is keyed by it. */
  settlementId: string;
  asset: string;
  /** Account whose escrow is closed (the buyer); receives the refund. */
  payerId: string;
  /** Account paid for the work (the provider). */
  payeeId: string;
  /** Total escrowed for this instruction: grossAmount + gas fee. */
  escrowAmount: bigint;
  grossAmount: bigint;
  /** Part of grossAmount paid to the payee before the Marketplace fee (0 = refund, gross = release). */
  providerAmount: bigint;
  /** Paymaster-sponsored gas included in the escrow (Marketplace orders only). */
  gas?: { fee: bigint; quoteId?: string };
  outcome: SettlementOutcome;
};

/** Pure result of planning an instruction (nothing moved yet). */
export type SettlementPlan = {
  instruction: PayoutInstruction;
  marketplaceFee: bigint;
  providerNet: bigint;
  gasCaptured: bigint;
  buyerRefund: bigint;
};

/**
 * Balance moves the engine needs from the owner of the escrow. The
 * Marketplace implements it over its own balance maps (orders: `held`;
 * categories: `categoryHeld`). The engine never touches balances otherwise.
 */
export interface SettlementLedgerPort {
  /** Escrow currently available for this instruction (must be >= escrowAmount). */
  escrowBalance(instruction: PayoutInstruction): bigint;
  /** Remove exactly `amount` from the escrow. */
  closeEscrow(instruction: PayoutInstruction, amount: bigint): void;
  /** Credit a spendable account. */
  credit(accountId: string, asset: string, amount: bigint): void;
  /** Record a Marketplace fee paid into the treasury. */
  recordFee(asset: string, amount: bigint): void;
  /** Record gas captured for the paymaster. */
  recordGas(asset: string, amount: bigint): void;
}

/** Receipt of one executed settlement; `receiptHash` commits to every other field. */
export type SettlementReceipt = {
  version: typeof SETTLEMENT_RECEIPT_VERSION;
  settlementId: string;
  asset: string;
  payerId: string;
  payeeId: string;
  grossAmount: bigint;
  providerAmount: bigint;
  marketplaceFee: bigint;
  providerNet: bigint;
  gasCaptured: bigint;
  buyerRefund: bigint;
  outcome: SettlementOutcome;
  /** Block height of the settlement (ADR 0002). */
  height: number;
  treasuryId: string;
  /** SHA-256 over the canonical JSON of the fields above (hex). */
  receiptHash: string;
};

/** Batch commitment over receipts (RFC 9162 tree of receipt hashes). */
export type SettlementBatch = {
  root: string;
  count: number;
  totals: Record<string, { gross: bigint; fees: bigint; providerNet: bigint; refunds: bigint; gas: bigint }>;
};
