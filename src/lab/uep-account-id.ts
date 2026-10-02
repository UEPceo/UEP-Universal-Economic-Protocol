/**
 * Canonical account identifiers.
 * Hex / Bech32 are case-insensitive; lab labels like "alice" stay as-is.
 */
export function canonicalAccountId(id: string): string {
  const t = id.trim();
  if (t.startsWith("0x") || t.startsWith("0X")) {
    return "0x" + t.slice(2).toLowerCase();
  }
  if (t.startsWith("uep1") || t.startsWith("UEP1")) {
    return t.toLowerCase();
  }
  return t;
}
