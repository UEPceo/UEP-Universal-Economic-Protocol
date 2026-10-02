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

/**
 * v0.4.7: `minFee` is the per-asset floor from the asset registry
 * (`AssetRecord.minProtocolFee`, default MIN_PROTOCOL_FEE). The 0.1% rate is
 * the same for every asset.
 */
export function creatorFee(amount: bigint, minFee: bigint = MIN_PROTOCOL_FEE): bigint {
  if (amount < 0n) throw new Error("amount must be non-negative");
  if (typeof minFee !== "bigint" || minFee < MIN_PROTOCOL_FEE) throw new Error("minFee must be at least MIN_PROTOCOL_FEE");
  if (amount === 0n) return 0n;
  const proportional = (amount * FEE_BPS) / BPS_DENOM;
  return proportional < minFee ? minFee : proportional;
}

/**
 * v0.4.7: largest amount a single note of value `noteValue` can pay
 * (amount + creatorFee(amount, minFee) <= noteValue), or 0n if none.
 */
export function maxPayableFromNote(noteValue: bigint, minFee: bigint = MIN_PROTOCOL_FEE): bigint {
  if (noteValue <= minFee) return 0n;
  // amount + amount/1000 <= noteValue  =>  amount ~ noteValue * 1000 / 1001
  let p = (noteValue * BPS_DENOM) / (BPS_DENOM + FEE_BPS);
  if (p > noteValue - minFee) p = noteValue - minFee;
  while (p > 0n && p + creatorFee(p, minFee) > noteValue) p--;
  while (p + 1n + creatorFee(p + 1n, minFee) <= noteValue) p++;
  return p;
}

/** v0.4.7: effective fee of a transfer in basis points of the amount (reporting helper). */
export function effectiveFeeBps(amount: bigint, minFee: bigint = MIN_PROTOCOL_FEE): bigint {
  if (amount <= 0n) return 0n;
  return (creatorFee(amount, minFee) * BPS_DENOM) / amount;
}

export function exactFeeEquation(amount: bigint, fee: bigint): boolean {
  return fee * BPS_DENOM === amount * FEE_BPS || fee === creatorFee(amount);
}

export function requiredSenderDebit(amount: bigint, minFee: bigint = MIN_PROTOCOL_FEE): bigint {
  return amount + creatorFee(amount, minFee);
}
