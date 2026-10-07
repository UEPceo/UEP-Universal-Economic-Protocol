#!/usr/bin/env node
/**
 * Offline check of the public BTC donation address (donations only; never an
 * investment). No dependencies, no network:
 *   1. every bc1 address in README.md and docs/*.md equals the expected one;
 *   2. the expected address is a valid BIP-173 bech32 segwit v0 address
 *      (checksum, HRP "bc", witness version 0, 20- or 32-byte program; v1+
 *      would need bech32m per BIP-350 and is checked as such).
 * Usage: node scripts/verify-donation-address.mjs [--self-test]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_BTC = "bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wgf";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data, from, to) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

/** Returns { ok: true, version, program } or { ok: false, reason }. */
export function decodeSegwitAddress(addr, expectedHrp = "bc") {
  if (typeof addr !== "string" || addr.length < 14 || addr.length > 90) return { ok: false, reason: "length" };
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return { ok: false, reason: "mixed case" };
  const a = addr.toLowerCase();
  const pos = a.lastIndexOf("1");
  if (pos < 1 || pos + 7 > a.length) return { ok: false, reason: "separator" };
  const hrp = a.slice(0, pos);
  if (hrp !== expectedHrp) return { ok: false, reason: `hrp ${hrp}` };
  const data = [];
  for (const c of a.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) return { ok: false, reason: `character ${c}` };
    data.push(d);
  }
  const check = polymod([...hrpExpand(hrp), ...data]);
  const version = data[0];
  if (version > 16) return { ok: false, reason: "witness version" };
  const want = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (check !== want) return { ok: false, reason: "checksum" };
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || program.length < 2 || program.length > 40) return { ok: false, reason: "program" };
  if (version === 0 && program.length !== 20 && program.length !== 32) return { ok: false, reason: "v0 program length" };
  return { ok: true, version, program };
}

function selfTest() {
  // BIP-173 / BIP-350 test vectors (valid and invalid).
  const valid = ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", EXPECTED_BTC];
  const invalid = ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "bc1zw508d6qejxtdg4y5r3zarvary0c5xw7kguw4zt", "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wgg", "bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wGf"];
  for (const v of valid) if (!decodeSegwitAddress(v).ok) throw new Error(`self-test: ${v} should be valid`);
  for (const v of invalid) if (decodeSegwitAddress(v).ok) throw new Error(`self-test: ${v} should be invalid`);
  console.log("bech32 self-test: OK (BIP-173/BIP-350 vectors)");
}

function main() {
  if (process.argv.includes("--self-test")) selfTest();
  const decoded = decodeSegwitAddress(EXPECTED_BTC);
  if (!decoded.ok) { console.error(`❌ expected donation address fails bech32 validation: ${decoded.reason}`); process.exit(1); }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = ["README.md", ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
  const found = new Map();
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    for (const m of text.matchAll(/\bbc1[02-9ac-hj-np-z]{8,87}\b/gi)) found.set(m[0], [...(found.get(m[0]) ?? []), f]);
  }
  if (found.size === 0) { console.error("❌ No BTC donation address found in public docs."); process.exit(1); }
  let ok = true;
  for (const [addr, where] of found) {
    if (addr !== EXPECTED_BTC) { ok = false; console.error(`❌ unexpected BTC address ${addr} in ${[...new Set(where)].join(", ")}`); }
  }
  if (!ok) process.exit(1);
  console.log(`✅ Donation address ${EXPECTED_BTC} (bech32 segwit v${decoded.version}, checksum OK) is the only BTC address in README.md and docs/ (${[...found.values()][0].length} occurrence(s)). Donations only.`);
}

main();
