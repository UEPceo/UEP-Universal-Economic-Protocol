/**
 * Offline LEI check (ISO 17442): 20 characters, 18 upper-case alphanumerics
 * followed by two check digits, valid when the ISO 7064 MOD 97-10 remainder
 * is 1 (letters A..Z count as 10..35). No network call, no cache, no registry
 * lookup: a valid checksum says nothing about whether the entity exists.
 * An LEI is only an optional, informational provider field; it never enters
 * a policy decision, a quote or ledger state.
 *
 * The check-digit generator emits 02..98 only (`98 - (prefix||"00" mod 97)`,
 * and that remainder is 0..96). Pairs 00, 01 and 99 are rejected even if a
 * crafted string still has remainder 1: ISO 17442 never generates them.
 */
const LEI_PATTERN = /^[0-9A-Z]{18}[0-9]{2}$/;

/** Check-digit pairs the ISO 7064 MOD 97-10 generator never emits. */
export const LEI_UNGENERATED_CHECK_DIGITS = ["00", "01", "99"] as const;

export function isValidLei(lei: string): boolean {
  if (typeof lei !== "string" || !LEI_PATTERN.test(lei)) return false;
  const check = lei.slice(18);
  if (check === "00" || check === "01" || check === "99") return false;
  let rem = 0;
  for (const ch of lei) {
    const code = ch.charCodeAt(0);
    const value = code <= 57 ? code - 48 : code - 55; // '0'..'9' -> 0..9, 'A'..'Z' -> 10..35
    rem = value >= 10 ? (rem * 100 + value) % 97 : (rem * 10 + value) % 97;
  }
  return rem === 1;
}

/** Two ISO 7064 MOD 97-10 check digits for an 18-character LEI prefix. */
export function leiCheckDigits(prefix18: string): string {
  if (typeof prefix18 !== "string" || !/^[0-9A-Z]{18}$/.test(prefix18)) throw new Error("LEI_PREFIX_INVALID");
  let rem = 0;
  for (const ch of prefix18 + "00") {
    const code = ch.charCodeAt(0);
    const value = code <= 57 ? code - 48 : code - 55;
    rem = value >= 10 ? (rem * 100 + value) % 97 : (rem * 10 + value) % 97;
  }
  const digits = String(98 - rem).padStart(2, "0");
  if (digits === "00" || digits === "01" || digits === "99") throw new Error("LEI_CHECK_DIGITS_UNGENERATED");
  return digits;
}
