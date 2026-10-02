/**
 * Ed25519 helpers on node:crypto (no third-party dependencies).
 *
 * Public keys are exchanged as hex-encoded SPKI DER (the same format used by
 * IoT machine identities). Raw 32-byte public keys (64 hex chars), PEM strings
 * and KeyObjects are also accepted.
 *
 * Status: IMPLEMENTED / TESTED (testnet signing; no HSM / key custody).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

export type PublicKeyLike = KeyObject | string;
export type PrivateKeyLike = KeyObject | string;

const RAW_ED25519_SPKI_PREFIX = "302a300506032b6570032100";

export function generateEd25519KeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey, publicKeyHex: publicKeyHexOf(publicKey) };
}

function assertEd25519(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("ED25519_KEY_REQUIRED");
  return key;
}

/** Normalize a public key (or derive it from a private KeyObject). */
export function toPublicKey(key: PublicKeyLike): KeyObject {
  if (typeof key !== "string") return assertEd25519(key.type === "private" ? createPublicKey(key) : key);
  const trimmed = key.trim();
  if (trimmed.startsWith("-----BEGIN")) return assertEd25519(createPublicKey(trimmed));
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) throw new Error("ED25519_PUBLIC_KEY_INVALID");
  const der = trimmed.length === 64 ? RAW_ED25519_SPKI_PREFIX + trimmed : trimmed;
  try {
    return assertEd25519(createPublicKey({ key: Buffer.from(der, "hex"), type: "spki", format: "der" }));
  } catch (error) {
    if (error instanceof Error && error.message === "ED25519_KEY_REQUIRED") throw error;
    throw new Error("ED25519_PUBLIC_KEY_INVALID");
  }
}

export function toPrivateKey(key: PrivateKeyLike): KeyObject {
  const k = typeof key === "string" ? createPrivateKey(key) : key;
  if (k.type !== "private") throw new Error("ED25519_PRIVATE_KEY_REQUIRED");
  return assertEd25519(k);
}

/** Canonical hex (SPKI DER) of a public key; accepts any PublicKeyLike or a private KeyObject. */
export function publicKeyHexOf(key: PublicKeyLike): string {
  return toPublicKey(key).export({ type: "spki", format: "der" }).toString("hex");
}

export function signEd25519(message: string | Uint8Array, privateKey: PrivateKeyLike): string {
  return cryptoSign(null, typeof message === "string" ? Buffer.from(message) : message, toPrivateKey(privateKey)).toString("hex");
}

export function verifyEd25519(message: string | Uint8Array, signatureHex: string, publicKey: PublicKeyLike): boolean {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    return cryptoVerify(null, typeof message === "string" ? Buffer.from(message) : message, toPublicKey(publicKey), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Deterministic JSON: object keys sorted, bigint encoded as decimal string with an `n` suffix. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(`${value}n`);
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
