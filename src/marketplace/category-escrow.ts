/**
 * v0.5.2: escrow port the Marketplace issues to the category modules
 * (src/category: swap, relay, dispute) and the subsidy port used by the drip
 * controller. Types only; the implementation lives in the Marketplace, over
 * its own balance maps, so the categories operate on the integrated balances
 * and treasury instead of private copies.
 *
 * Rules enforced by the Marketplace behind this port:
 *  - one port per module name (a second request throws);
 *  - a module sees and moves only its own holds;
 *  - holds are taken from Marketplace `accounts` of registered identities and
 *    counted in `categoryHeld` (valueAccounting) while open;
 *  - every payout to a provider goes through the settlement engine (one fee
 *    path); a plain release must pay out exactly the held amount;
 *  - treasury shares of slashes and forfeits go to RISK_RESERVE;
 *  - amounts are bigint; heights come from the Marketplace clock.
 * Every method validates fully before it changes anything, so a refused call
 * leaves no partial state. Status: IMPLEMENTED (testnet reference).
 */
import type { ActorAuth, CategoryAction } from "./identity.ts";
import type { SettlementPlan, SettlementReceipt } from "../settlement/types.ts";

export type CategoryModuleName = "swap" | "relay" | "dispute";

export type CategoryHoldState = "OPEN" | "RELEASED" | "REFUNDED" | "SETTLED";

export type CategoryHoldView = {
  holdId: string;
  module: CategoryModuleName;
  accountId: string;
  asset: string;
  amount: bigint;
  state: CategoryHoldState;
};

export type CategoryPayout = { to: string; amount: bigint };

export interface CategoryEscrowPort {
  readonly module: CategoryModuleName;
  readonly marketplaceId: string;
  /** Current Marketplace height (ADR 0002). */
  height(): number;
  /** Verify a category action signed by a registered identity (returns the actor id). */
  authenticate(auth: ActorAuth | undefined, action: CategoryAction, target: string, details: Record<string, unknown>): string;
  isRegistered(identityId: string): boolean;
  /** Throws unless the asset is accepted by the Marketplace (ADR 0001 rules). */
  assertAsset(asset: string): string;
  available(accountId: string, asset: string): bigint;
  /** Marketplace fee the treasury would charge on a provider amount (no state change). */
  quoteFee(amount: bigint, asset: string): bigint;
  /** Throws INSUFFICIENT_FUNDS unless every hold can be opened together. */
  assertCanOpen(holds: readonly { accountId: string; asset: string; amount: bigint }[]): void;
  openHold(holdId: string, accountId: string, asset: string, amount: bigint): void;
  hold(holdId: string): CategoryHoldView | undefined;
  refundHold(holdId: string): void;
  /** Pay out exactly the held amount to registered identities and, optionally, a treasury RISK_RESERVE share. */
  releaseHold(holdId: string, payouts: readonly CategoryPayout[], riskReserve?: { refId: string; amount: bigint }): void;
  /** Plan a settlement of a hold (pure). The remainder returns to the hold's account. */
  planSettlement(holdId: string, payeeId: string, providerAmount: bigint, settlementId: string): SettlementPlan;
  /** Settle a hold through the settlement engine: provider amount (fee on it) to payee, rest to the hold's account. */
  settleHold(holdId: string, payeeId: string, providerAmount: bigint, settlementId: string): SettlementReceipt;
}

/** Drip subsidy port (issued once): pays out of the treasury drip budget into a node's account. */
export interface SubsidyPort {
  height(): number;
  authenticate(auth: ActorAuth | undefined, action: CategoryAction, target: string, details: Record<string, unknown>): string;
  isRegistered(identityId: string): boolean;
  budgetOf(asset: string): bigint;
  pay(claimId: string, nodeId: string, asset: string, amount: bigint): void;
}
