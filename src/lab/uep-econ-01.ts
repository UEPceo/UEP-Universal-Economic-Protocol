/**
 * UEP-ECON-01 — Economically meaningful transaction (lab)
 *
 * Directive: infrastructure exists to finalize *economic* state.
 * This module does not invent tokenomics. It makes explicit:
 *   amount transferred + protocol fee + treasury accrual + conservation
 * on top of existing creatorFee / LocalEconomicState / SmtEconomicState.
 *
 * Status: LAB / DEMONSTRATED on MultiNodeCluster (+ optional Poseidon SMT).
 */

import { creatorFee, FEE_BPS, BPS_DENOM, requiredSenderDebit } from "../core/fee.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

export const ECON_01_VERSION = "ECON-01";

/** Snapshot of observable economic quantities (single node tip). */
export type EconomicSnapshot = {
  balances: Record<string, string>;
  treasury: string;
  /** Sum of all account balances (excludes treasury). */
  sumAccounts: string;
  /** sumAccounts + treasury */
  totalSupplyTracked: string;
  stateRoot: string;
  sequence: number;
};

export type EconomicReceipt = {
  version: typeof ECON_01_VERSION;
  txId: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  feeBps: string;
  senderDebit: string;
  before: EconomicSnapshot;
  after: EconomicSnapshot;
  treasuryDelta: string;
  recipientDelta: string;
  senderDelta: string;
  /** true iff totalSupplyTracked unchanged (no mint/burn outside fee path). */
  conservationHolds: boolean;
  /** true iff fee === creatorFee(amount) */
  feePolicyHolds: boolean;
  /** true iff amount >= 1000 so fee > 0 under current integer policy */
  feeNonZero: boolean;
  economicallyMeaningful: boolean;
};

export type EconomicStateView = {
  balance(id: string): bigint;
  treasuryBalance: bigint;
  stateRoot(): string;
  sequence: number;
  balancesSnapshot(): Record<string, string>;
};

export function sumAccountBalances(balances: Record<string, string>): bigint {
  let s = 0n;
  for (const [k, v] of Object.entries(balances)) {
    if (k.startsWith("__")) continue;
    s += BigInt(v);
  }
  return s;
}

export function snapshotEconomic(s: EconomicStateView): EconomicSnapshot {
  const balances = s.balancesSnapshot();
  const sumAccounts = sumAccountBalances(balances);
  const treasury = s.treasuryBalance;
  return {
    balances,
    treasury: treasury.toString(),
    sumAccounts: sumAccounts.toString(),
    totalSupplyTracked: (sumAccounts + treasury).toString(),
    stateRoot: s.stateRoot(),
    sequence: s.sequence,
  };
}

/**
 * Build a receipt for a single transfer under current fee policy.
 * Does not apply the transfer — pure accounting check given before/after views.
 */
export function buildReceipt(args: {
  tx: BatchTx;
  before: EconomicSnapshot;
  after: EconomicSnapshot;
}): EconomicReceipt {
  const amount = args.tx.amount;
  const fee = creatorFee(amount);
  const senderDebit = requiredSenderDebit(amount);
  const beforeFrom = BigInt(args.before.balances[args.tx.from] ?? "0");
  const afterFrom = BigInt(args.after.balances[args.tx.from] ?? "0");
  const beforeTo = BigInt(args.before.balances[args.tx.to] ?? "0");
  const afterTo = BigInt(args.after.balances[args.tx.to] ?? "0");
  const beforeT = BigInt(args.before.treasury);
  const afterT = BigInt(args.after.treasury);

  const conservationHolds =
    args.before.totalSupplyTracked === args.after.totalSupplyTracked;
  const feePolicyHolds = fee === creatorFee(amount);
  const feeNonZero = fee > 0n;
  const senderDeltaOk = afterFrom === beforeFrom - senderDebit;
  const recipientDeltaOk = afterTo === beforeTo + amount;
  const treasuryDeltaOk = afterT === beforeT + fee;

  const economicallyMeaningful =
    feeNonZero &&
    conservationHolds &&
    feePolicyHolds &&
    senderDeltaOk &&
    recipientDeltaOk &&
    treasuryDeltaOk &&
    args.before.stateRoot !== args.after.stateRoot;

  return {
    version: ECON_01_VERSION,
    txId: args.tx.id,
    from: args.tx.from,
    to: args.tx.to,
    amount: amount.toString(),
    fee: fee.toString(),
    feeBps: FEE_BPS.toString(),
    senderDebit: senderDebit.toString(),
    before: args.before,
    after: args.after,
    treasuryDelta: (afterT - beforeT).toString(),
    recipientDelta: (afterTo - beforeTo).toString(),
    senderDelta: (afterFrom - beforeFrom).toString(),
    conservationHolds,
    feePolicyHolds,
    feeNonZero,
    economicallyMeaningful,
  };
}

/** Minimum amount such that creatorFee(amount) > 0 under floor(amount/1000). */
/** With the 1-unit fee floor every positive amount pays a protocol fee. */
export const ECON_01_MIN_MEANINGFUL_AMOUNT = 1n;

export function isEconomicallyMeaningfulAmount(amount: bigint): boolean {
  return creatorFee(amount) > 0n;
}

export { creatorFee, FEE_BPS, BPS_DENOM, requiredSenderDebit };
