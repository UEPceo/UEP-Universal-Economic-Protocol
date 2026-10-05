/**
 * UEP account addresses.
 *
 *   address = Bech32m(hrp = "uep", data = version || networkTag || body)
 *
 * v3 (since v0.5.1, the format of new addresses):
 *   version    1 byte   0x03 (= ACCOUNT_ID_VERSION)
 *   networkTag 4 bytes  SHA-256("UEP-ADDR-NETWORK-v2\n" || networkId)[0..4]
 *   body       31 bytes 23-byte key hash || 8-byte check (see spend-key.ts)
 *
 * v2 (v0.4.5 to v0.5.0, still decoded for existing accounts):
 *   version    1 byte   0x02 (= ACCOUNT_ID_VERSION_V2)
 *   networkTag 4 bytes  as above
 *   body       31 bytes SHA-256("UEP-ACCOUNT-KEY-v2\n" || raw32(spendPublicKey))[0..31]
 *
 * The ledger account id is version || body (see spend-key.ts), so an address
 * commits to the owner's Ed25519 spend key. Decoding a v3 address also checks
 * the 64-bit id check (ADDRESS_ID_CHECK). A v2 address decodes to its v2 id;
 * the ledger decides whether it accepts that id as a recipient. Bech32m (BIP-350) gives a
 * 6-character BCH checksum over the HRP and data; addresses are lowercase,
 * 68 characters long and start with "uep1". The network tag makes an address
 * for one network fail to decode on another.
 *
 * v1 (`uep:<networkId>:<accountIdHex>`, accounts = H(secret, salt)) is no
 * longer valid: decoding it reports ADDRESS_LEGACY_V1.
 */
import { createHash } from "node:crypto";
import { Fr } from "./field.ts";
import { ACCOUNT_ID_VERSION, ACCOUNT_ID_VERSION_V2, accountIdFromKeyHash, accountIdFromSpendKey, isKeyDerivedAccountId, isV2AccountIdForm, keyHashOfAccountId } from "./spend-key.ts";
import type { PublicKeyLike } from "./ed25519.ts";

export const ADDRESS_VERSION = 3;
export const ADDRESS_VERSION_V2 = 2;
export const ADDRESS_HRP = "uep";
const NETWORK_TAG_DOMAIN = "UEP-ADDR-NETWORK-v2\n";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const PAYLOAD_BYTES = 1 + 4 + 31;

export type AddressErrorCode =
  | "ADDRESS_FORMAT"
  | "ADDRESS_LEGACY_V1"
  | "ADDRESS_HRP"
  | "ADDRESS_CHECKSUM"
  | "ADDRESS_LENGTH"
  | "ADDRESS_VERSION"
  | "ADDRESS_NETWORK"
  | "ADDRESS_ID_CHECK";

export type DecodedAddress = { version: 2 | 3; networkTag: string; accountId: Fr };
export type AddressDecodeResult = ({ ok: true } & DecodedAddress) | { ok: false; code: AddressErrorCode; message: string };

export interface AddressEncoder {
  encode(networkId: string, accountId: Fr): string;
  decode(address: string, expectedNetworkId?: string): DecodedAddress | null;
}

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i]!;
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

/** Low-level Bech32m encoding of arbitrary bytes (tooling / tests). */
export function bech32mEncode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits(bytes, 8, 5, true)!;
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((d) => CHARSET[d]).join("");
}

/** True iff `s` is a well-formed Bech32m string (any HRP) with a valid checksum (BIP-350). */
export function isValidBech32m(s: string): boolean {
  if (typeof s !== "string" || s.length < 8 || s.length > 90) return false;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return false;
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) { const c = hrp.charCodeAt(i); if (c < 33 || c > 126) return false; }
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) { const d = CHARSET.indexOf(ch); if (d < 0) return false; data.push(d); }
  return polymod([...hrpExpand(hrp), ...data]) === BECH32M_CONST;
}

/** Network tag bound into v2 addresses (hex, 4 bytes). */
export function addressNetworkTag(networkId: string): string {
  return createHash("sha256").update(NETWORK_TAG_DOMAIN + networkId, "utf8").digest().subarray(0, 4).toString("hex");
}

/**
 * Encode a key-derived account id as an address for `networkId`: a v3 id gives
 * a v3 address; an existing v2-form id gives the v2 address it always had.
 */
export function encodeAccountAddress(networkId: string, accountId: Fr): string {
  if (!networkId) throw new Error("ADDRESS_NETWORK: networkId required");
  const version = isKeyDerivedAccountId(accountId) ? ACCOUNT_ID_VERSION : isV2AccountIdForm(accountId) ? ACCOUNT_ID_VERSION_V2 : undefined;
  if (version === undefined) throw new Error("ADDRESS_VERSION: account id is not a key-derived account");
  const payload = Buffer.concat([Buffer.from([version]), Buffer.from(addressNetworkTag(networkId), "hex"), keyHashOfAccountId(accountId)]);
  return bech32mEncode(ADDRESS_HRP, payload);
}

/** v3 address of an Ed25519 spend public key. */
export function addressFromSpendKey(networkId: string, publicKey: PublicKeyLike): string {
  return encodeAccountAddress(networkId, accountIdFromSpendKey(publicKey));
}

/** Decode and fully validate a v3 or v2 address. Never throws. */
export function decodeAccountAddress(address: string, expectedNetworkId?: string): AddressDecodeResult {
  const err = (code: AddressErrorCode, message: string): AddressDecodeResult => ({ ok: false, code, message });
  if (typeof address !== "string") return err("ADDRESS_FORMAT", "address must be a string");
  const raw = address.trim();
  if (/^uep:[^:]*:[0-9a-fA-F]{64}$/.test(raw)) return err("ADDRESS_LEGACY_V1", "v1 addresses (uep:<network>:<hex>) are no longer valid; re-create the account with v0.4.5");
  if (raw.length < 8 || raw.length > 90) return err("ADDRESS_LENGTH", "address length is invalid");
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) return err("ADDRESS_FORMAT", "mixed-case address");
  const s = raw.toLowerCase();
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 33 || c > 126) return err("ADDRESS_FORMAT", "invalid character"); }
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) return err("ADDRESS_FORMAT", "missing separator or checksum");
  const hrp = s.slice(0, sep);
  if (hrp !== ADDRESS_HRP) return err("ADDRESS_HRP", `expected human-readable part "${ADDRESS_HRP}"`);
  const data: number[] = [];
  for (const ch of s.slice(sep + 1)) { const d = CHARSET.indexOf(ch); if (d < 0) return err("ADDRESS_FORMAT", "invalid Bech32 character"); data.push(d); }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) return err("ADDRESS_CHECKSUM", "Bech32m checksum mismatch");
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== PAYLOAD_BYTES) return err("ADDRESS_LENGTH", "unexpected payload length");
  const version = bytes[0];
  if (version !== ACCOUNT_ID_VERSION && version !== ACCOUNT_ID_VERSION_V2) return err("ADDRESS_VERSION", `unsupported address version ${version}`);
  const networkTag = Buffer.from(bytes.slice(1, 5)).toString("hex");
  if (expectedNetworkId !== undefined && networkTag !== addressNetworkTag(expectedNetworkId)) return err("ADDRESS_NETWORK", "address belongs to a different network");
  let accountId: Fr;
  try { accountId = accountIdFromKeyHash(Uint8Array.from(bytes.slice(5)), version); } catch { return err("ADDRESS_ID_CHECK", "account id check mismatch"); }
  return { ok: true, version: version === ACCOUNT_ID_VERSION ? 3 : 2, networkTag, accountId };
}

/** Decode a v3 or v2 address for `networkId` or throw `<ADDRESS_CODE>: message`. */
export function parseAccountAddress(address: string, networkId: string): Fr {
  const r = decodeAccountAddress(address, networkId);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.accountId;
}

export const UepAddressV2: AddressEncoder = {
  encode: encodeAccountAddress,
  decode(address: string, expectedNetworkId?: string): DecodedAddress | null {
    const r = decodeAccountAddress(address, expectedNetworkId);
    return r.ok ? { version: r.version, networkTag: r.networkTag, accountId: r.accountId } : null;
  },
};

/**
 * @deprecated v0.4.5: v1 addresses are invalid. `encode` throws and `decode`
 * always returns null. Use UepAddressV2 / encodeAccountAddress.
 */
export const UepAddressV1: AddressEncoder = {
  encode(): string {
    throw new Error("ADDRESS_LEGACY_V1: v1 addresses are no longer supported; use encodeAccountAddress (v2)");
  },
  decode(): DecodedAddress | null {
    return null;
  },
};

export function shortId(hex: string, n = 6): string {
  if (hex.length <= n * 2 + 1) return hex;
  return hex.slice(0, n) + "…" + hex.slice(-n);
}
