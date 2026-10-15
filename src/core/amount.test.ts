/** 0.5.81 item 8: numeric rules (u64, integer-only, canonical fee rounding, conservation). Seed: UEP_NUM_SEED (default 20261015). */
import test from "node:test";
import assert from "node:assert/strict";
import { U64_MAX, addU64, parseAmount, parseDecimalUnits, subU64 } from "./amount.ts";
import { BPS_DENOM, FEE_BPS, MIN_PROTOCOL_FEE, creatorFee, maxPayableFromNote } from "./fee.ts";
import { deserializeNote } from "./note.ts";

const SEED = Number(process.env.UEP_NUM_SEED ?? 20261015) >>> 0 || 1;
function prng(seed: number) { let x = seed; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
const rand64 = (r: () => number) => ((BigInt(r()) << 32n) | BigInt(r())) & U64_MAX;

test("item 8: parseAmount refuses negative, NaN, Infinity, floats, exponents, hex, signs, padding, leading zeros, > u64, non-numeric types", () => {
  for (const bad of [-1, -1n, NaN, Infinity, -Infinity, 1.5, 0.1, 2 ** 53, "1.0", "1e3", "0x10", "+1", "-1", " 1", "1 ", "01", "", "1_000", "١", U64_MAX + 1n, (U64_MAX + 1n).toString(), "99999999999999999999999", null, undefined, true, {}, [1]])
    assert.throws(() => parseAmount(bad as never), /AMOUNT_(INVALID|OUT_OF_RANGE)/, `accepted ${String(bad)}`);
  for (const [ok, want] of [[0, 0n], [1, 1n], ["0", 0n], ["18446744073709551615", U64_MAX], [U64_MAX, U64_MAX], [Number.MAX_SAFE_INTEGER, 9007199254740991n]] as const)
    assert.equal(parseAmount(ok), want);
});

test("item 8: decimal units are exact; extra precision is refused, never rounded", () => {
  assert.equal(parseDecimalUnits("12.34", 2), 1234n);
  assert.equal(parseDecimalUnits("12", 2), 1200n);
  assert.equal(parseDecimalUnits("0.5", 6), 500_000n);
  for (const bad of ["12.345", "1.", ".5", "-1", "1e2", "01.0"]) assert.throws(() => parseDecimalUnits(bad, 2), /AMOUNT_/);
  assert.throws(() => parseDecimalUnits("1", 19), /DECIMALS/);
  assert.throws(() => parseDecimalUnits("18446744073709551616", 0), /OUT_OF_RANGE/);
});

test(`item 8: canonical fee rounding (0.1%, floor, min 1) and per-asset conservation over random u64 amounts (seed ${SEED})`, () => {
  assert.equal(FEE_BPS, 10n); assert.equal(BPS_DENOM, 10_000n);
  const r = prng(SEED);
  for (let i = 0; i < 5_000; i++) {
    const amount = i % 3 === 0 ? BigInt(r() % 5000) : rand64(r) >> BigInt(r() % 60);
    const fee = creatorFee(amount);
    if (amount === 0n) { assert.equal(fee, 0n); continue; }
    assert.equal(fee, (amount * 10n) / 10_000n < MIN_PROTOCOL_FEE ? MIN_PROTOCOL_FEE : (amount * 10n) / 10_000n);
    assert.ok(fee * 1000n <= amount || fee === MIN_PROTOCOL_FEE, "fee never rounds up beyond floor");
    // Conservation of a payment from a note of value v: v = amount + fee + change, all u64.
    const v = amount + fee + BigInt(r() % 1000);
    if (v > U64_MAX) continue;
    const change = subU64(subU64(v, amount), fee);
    assert.equal(addU64(addU64(amount, fee), change), v);
    const max = maxPayableFromNote(v);
    assert.ok(max + creatorFee(max) <= v && (max + 1n) + creatorFee(max + 1n) > v);
  }
  assert.throws(() => creatorFee(-1n));
  assert.throws(() => addU64(U64_MAX, 1n), /OVERFLOW/);
  assert.throws(() => subU64(1n, 2n), /UNDERFLOW/);
});

test("item 8: notes transported or restored with a non-u64 amount are refused", () => {
  const base = { assetId: "01", owner: "02", blinding: "03", commitment: "04", nonce: "05", spent: false };
  for (const amount of ["-1", "1.5", "18446744073709551616", "1e3"]) assert.throws(() => deserializeNote({ ...base, amount } as never), /AMOUNT_/);
  assert.equal(deserializeNote({ ...base, amount: "7" } as never).amount, 7n);
});
