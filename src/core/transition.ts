/**
 * UEP-25 atomic sender/recipient/treasury transition.
 * Status: IMPLEMENTED / TESTED
 */
import { creatorFee } from "./fee.ts";

export type Balances = {
  sender: bigint;
  recipient: bigint;
  treasury: bigint;
};

export type Transition = {
  old: Balances;
  amount: bigint;
  new: Balances;
  fee: bigint;
};

export type TransitionError =
  | "InsufficientSenderBalance"
  | "RecipientOverflow"
  | "TreasuryOverflow"
  | "ConservationFailure";

const U64_MAX = 2n ** 64n - 1n;

function fitsU64(n: bigint): boolean {
  return n >= 0n && n <= U64_MAX;
}

export function transition(old: Balances, amount: bigint): { ok: Transition } | { err: TransitionError } {
  if (amount < 0n || !fitsU64(amount)) return { err: "InsufficientSenderBalance" };
  const fee = creatorFee(amount);
  const required = amount + fee;
  if (old.sender < required) return { err: "InsufficientSenderBalance" };
  const sender = old.sender - required;
  const recipient = old.recipient + amount;
  const treasury = old.treasury + fee;
  if (!fitsU64(recipient)) return { err: "RecipientOverflow" };
  if (!fitsU64(treasury)) return { err: "TreasuryOverflow" };
  const next: Balances = { sender, recipient, treasury };
  const oldTotal = old.sender + old.recipient + old.treasury;
  const newTotal = next.sender + next.recipient + next.treasury;
  if (oldTotal !== newTotal) return { err: "ConservationFailure" };
  return { ok: { old, amount, new: next, fee } };
}

export function assertConserving(old: Balances, next: Balances): boolean {
  return old.sender + old.recipient + old.treasury === next.sender + next.recipient + next.treasury;
}
