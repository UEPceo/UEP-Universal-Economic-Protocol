/**
 * Key-derivation for the wallet vault. This is the KEYSTORE layer, not the
 * UEP protocol hash. SHA-256 / PBKDF2 / AES-GCM are used only to wrap secrets
 * at rest. Protocol objects always go through UEP-25 `h()`.
 *
 * Status: IMPLEMENTED (Web Crypto). Android analog: Android Keystore.
 */
import { Fr } from "../core/field.ts";
import { accountIdFromSpendKey, accountIdFromSpendKeyV2, deriveSpendKey } from "../core/spend-key.ts";

const te = new TextEncoder();

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

export async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return new Uint8Array(sig);
}

export async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
  hash: "SHA-256" | "SHA-512" = "SHA-256",
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(pt);
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type IdentitySecrets = {
  mnemonic: string;
  seed: Uint8Array;
  secret: Fr;
  salt: Fr;
  /**
   * v0.4.5: key-derived account id (UEP-ADDR-002), committing to the
   * deterministic Ed25519 spend key of (secret, salt).
   */
  accountId: Fr;
  /** v0.4.5: hex SPKI DER Ed25519 spend public key that `accountId` commits to. */
  spendPublicKey: string;
  /**
   * v0.5.1: the v2 id of the same spend key (accounts created v0.4.5 to
   * v0.5.0). `accountId` is the v3 id for new identities; withAccountIdV2()
   * selects the v2 id to spend notes still held there.
   */
  accountIdV2?: Fr;
};

/** The same identity acting as its v2 account (to spend notes of an existing v2 account). */
export function withAccountIdV2(secrets: IdentitySecrets): IdentitySecrets {
  return { ...secrets, accountId: secrets.accountIdV2 ?? accountIdFromSpendKeyV2(secrets.spendPublicKey) };
}

export async function deriveIdentity(seed: Uint8Array, mnemonic: string): Promise<IdentitySecrets> {
  const secretBytes = await hmacSha256(seed, te.encode("UEP v0.1 account secret"));
  const saltBytes = await hmacSha256(seed, te.encode("UEP v0.1 account salt"));
  const secret = Fr.fromBytesBE(secretBytes);
  const salt = Fr.fromBytesBE(saltBytes);
  const spendPublicKey = deriveSpendKey(secret, salt).publicKeyHex;
  const accountId = accountIdFromSpendKey(spendPublicKey);
  const accountIdV2 = accountIdFromSpendKeyV2(spendPublicKey);
  return { mnemonic, seed, secret, salt, accountId, spendPublicKey, accountIdV2 };
}

export const PIN_ITERATIONS = 100_000;
