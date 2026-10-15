/**
 * 0.5.81 item 8: one strict parser for amounts that cross a trust boundary
 * (HTTP/JSON input, snapshots, transported notes, worker messages).
 *
 * Amounts are unsigned 64-bit integers in the asset's smallest unit. Accepted:
 *   - bigint in [0, U64_MAX]
 *   - number that is a safe integer >= 0 (never a float, NaN or Infinity)
 *   - canonical decimal string /^(0|[1-9][0-9]*)$/ <= U64_MAX (no sign, spaces, exponent, hex, leading zeros)
 * Everything else is refused with AMOUNT_INVALID / AMOUNT_OUT_OF_RANGE. No rounding happens here.
 * Human decimal amounts go through parseDecimalUnits() with the asset's decimals; extra
 * fractional digits are refused, never rounded.
 */
export const U64_MAX = 2n ** 64n - 1n;
const CANONICAL = /^(0|[1-9][0-9]{0,19})$/;

export function isU64(n: bigint): boolean { return n >= 0n && n <= U64_MAX; }

export function parseAmount(raw: unknown, what = "amount"): bigint {
  let n: bigint;
  if (typeof raw === "bigint") n = raw;
  else if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) throw new Error(`AMOUNT_INVALID: ${what} must be an integer (got ${raw})`);
    n = BigInt(raw);
  } else if (typeof raw === "string") {
    if (!CANONICAL.test(raw)) throw new Error(`AMOUNT_INVALID: ${what} must be a canonical non-negative decimal integer`);
    n = BigInt(raw);
  } else throw new Error(`AMOUNT_INVALID: ${what} has type ${raw === null ? "null" : typeof raw}`);
  if (n < 0n) throw new Error(`AMOUNT_INVALID: ${what} is negative`);
  if (n > U64_MAX) throw new Error(`AMOUNT_OUT_OF_RANGE: ${what} exceeds u64`);
  return n;
}

/** "12.34" with decimals=2 -> 1234n. Refuses more fractional digits than `decimals`, signs, exponents. */
export function parseDecimalUnits(raw: string, decimals: number, what = "amount"): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("AMOUNT_DECIMALS_INVALID");
  if (typeof raw !== "string") throw new Error(`AMOUNT_INVALID: ${what}`);
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(raw);
  if (!m) throw new Error(`AMOUNT_INVALID: ${what} is not a plain decimal`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`AMOUNT_PRECISION: ${what} has more than ${decimals} decimals`);
  return parseAmount((BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString(), what);
}

/** Checked u64 add/sub (no silent wrap, no negative result). */
export function addU64(a: bigint, b: bigint): bigint { const r = a + b; if (!isU64(a) || !isU64(b) || r > U64_MAX) throw new Error("AMOUNT_OVERFLOW"); return r; }
export function subU64(a: bigint, b: bigint): bigint { if (!isU64(a) || !isU64(b) || b > a) throw new Error("AMOUNT_UNDERFLOW"); return a - b; }
