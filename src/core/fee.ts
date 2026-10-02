/**
 * Creator fee policy from UEP-25: 0.1% of the amount.
 * fee = max(MIN_PROTOCOL_FEE, floor(amount * 10 / 10_000)) for amount > 0
 *
 * v0.4.4 (UEP-A16): every positive transfer pays at least 1 unit, so small
 * transfers can no longer round down to a zero fee. Amounts >= 1_000 pay
 * exactly floor(0.1%) as before.
 * Status: IMPLEMENTED / TESTED
 */
export const FEE_BPS = 10n;
export const BPS_DENOM = 10_000n;
/** Minimum protocol fee for any positive amount (smallest asset unit). */
export const MIN_PROTOCOL_FEE = 1n;

export function creatorFee(amount: bigint): bigint {
  if (amount < 0n) throw new Error("amount must be non-negative");
  if (amount === 0n) return 0n;
  const proportional = (amount * FEE_BPS) / BPS_DENOM;
  return proportional < MIN_PROTOCOL_FEE ? MIN_PROTOCOL_FEE : proportional;
}

export function exactFeeEquation(amount: bigint, fee: bigint): boolean {
  return fee * BPS_DENOM === amount * FEE_BPS || fee === creatorFee(amount);
}

export function requiredSenderDebit(amount: bigint): bigint {
  return amount + creatorFee(amount);
}
