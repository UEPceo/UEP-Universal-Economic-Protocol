/**
 * Creator fee policy from UEP-25.
 * fee = floor(amount * 10 / 10_000) = floor(amount / 1_000)
 *
 * Amounts 1–999 pay zero. This is an explicit integer policy, not a law of nature.
 * Status: IMPLEMENTED / TESTED
 */
export const FEE_BPS = 10n;
export const BPS_DENOM = 10_000n;

export function creatorFee(amount: bigint): bigint {
  if (amount < 0n) throw new Error("amount must be non-negative");
  return (amount * FEE_BPS) / BPS_DENOM;
}

export function exactFeeEquation(amount: bigint, fee: bigint): boolean {
  return fee * BPS_DENOM === amount * FEE_BPS || fee === creatorFee(amount);
}

export function requiredSenderDebit(amount: bigint): bigint {
  return amount + creatorFee(amount);
}
