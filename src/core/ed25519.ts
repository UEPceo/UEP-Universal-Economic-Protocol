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
import { isAcceptableEd25519R, isCanonicalEd25519S, isPrimeOrderEd25519Point } from "./ed25519-point.ts";

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

/** v0.5.3: bounded cache of public-key point checks (keys repeat; the check costs about 1 ms). */
const POINT_CHECK_CACHE = new Map<string, boolean>();
const POINT_CHECK_CACHE_MAX = 8192;

/** v0.5.3: true iff the raw 32-byte key is a canonical prime-order point (cached). */
export function isStrictEd25519PublicKey(publicKey: PublicKeyLike): boolean {
  const cacheKey = typeof publicKey === "string" ? publicKey : undefined;
  if (cacheKey !== undefined) {
    const hit = POINT_CHECK_CACHE.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  let ok: boolean;
  try { ok = isPrimeOrderEd25519Point(Buffer.from(publicKeyHexOf(publicKey).slice(-64), "hex")); } catch { ok = false; }
  if (cacheKey !== undefined) {
    if (POINT_CHECK_CACHE.size >= POINT_CHECK_CACHE_MAX) POINT_CHECK_CACHE.clear();
    POINT_CHECK_CACHE.set(cacheKey, ok);
  }
  return ok;
}

/**
 * Verify an Ed25519 signature. v0.5.3: strict and independent of the Node /
 * OpenSSL version: the public key must be a canonical prime-order point
 * (small-order, identity and off-curve keys are refused), R must be a
 * canonical non-small-order encoding and S must be < L, before the backend
 * verification runs. Node 22 and Node 24 therefore give the same answer.
 */
export function verifyEd25519(message: string | Uint8Array, signatureHex: string, publicKey: PublicKeyLike): boolean {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const sig = Buffer.from(signatureHex, "hex");
    if (!isAcceptableEd25519R(sig.subarray(0, 32)) || !isCanonicalEd25519S(sig.subarray(32, 64))) return false;
    if (!isStrictEd25519PublicKey(publicKey)) return false;
    return cryptoVerify(null, typeof message === "string" ? Buffer.from(message) : message, toPublicKey(publicKey), sig);
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
