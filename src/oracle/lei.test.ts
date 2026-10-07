import test from "node:test";
import assert from "node:assert/strict";
import { isValidLei, leiCheckDigits } from "./lei.ts";

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
