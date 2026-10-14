import test from "node:test";
import assert from "node:assert/strict";
import { isValidLei, leiCheckDigits, LEI_UNGENERATED_CHECK_DIGITS } from "./lei.ts";

test("LEI: published LEIs pass the ISO 17442 / ISO 7064 MOD 97-10 check offline", () => {
  for (const lei of ["5493001KJTIIGC8Y1R12", "HWUPKR0MPOU8FGXBT394", "7LTWFZYICNSX8D621K86"]) {
    assert.equal(isValidLei(lei), true, lei);
    assert.equal(leiCheckDigits(lei.slice(0, 18)), lei.slice(18), lei);
  }
});

test("LEI: wrong check digits, transposed characters, bad length or alphabet are rejected", () => {
  assert.equal(isValidLei("5493001KJTIIGC8Y1R13"), false);
  assert.equal(isValidLei("4593001KJTIIGC8Y1R12"), false);
  assert.equal(isValidLei("5493001KJTIIGC8Y1R1"), false);
  assert.equal(isValidLei("5493001KJTIIGC8Y1R123"), false);
  assert.equal(isValidLei("5493001kjtiigc8y1r12"), false);
  assert.equal(isValidLei("5493001KJTIIGC8Y1RAB"), false);
  assert.equal(isValidLei(""), false);
  assert.throws(() => leiCheckDigits("SHORT"), /LEI_PREFIX_INVALID/);
});

test("LEI: check pairs the generator never emits are rejected even if the remainder is 1", () => {
  // Crafted so the full string is 1 mod 97, but the pairs are 00, 01 and 99.
  for (const lei of ["00000000000000006500", "00000000000000000001", "00000000000000000W99"]) {
    assert.equal(isValidLei(lei), false, lei);
    assert.equal(LEI_UNGENERATED_CHECK_DIGITS.includes(lei.slice(18) as "00"), true);
  }
  for (let n = 0; n < 200; n++) {
    const prefix = n.toString(36).toUpperCase().padStart(18, "0");
    const digits = leiCheckDigits(prefix);
    assert.equal(digits === "00" || digits === "01" || digits === "99", false, prefix);
    assert.equal(isValidLei(prefix + digits), true, prefix);
  }
});
