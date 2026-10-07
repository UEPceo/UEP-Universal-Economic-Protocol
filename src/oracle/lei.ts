/**
 * Offline LEI check (ISO 17442): 20 characters, 18 upper-case alphanumerics
 * followed by two check digits, valid when the ISO 7064 MOD 97-10 remainder
 * is 1 (letters A..Z count as 10..35). No network call, no cache, no registry
 * lookup: a valid checksum says nothing about whether the entity exists.
 * An LEI is only an optional, informational provider field; it never enters
 * a policy decision, a quote or ledger state.
 */
const LEI_PATTERN = /^[0-9A-Z]{18}[0-9]{2}$/;

export function isValidLei(lei: string): boolean {
  if (typeof lei !== "string" || !LEI_PATTERN.test(lei)) return false;
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
  return String(98 - rem).padStart(2, "0");
}
