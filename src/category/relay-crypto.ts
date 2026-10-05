/**
 * Cryptography used only by category adapters (v0.5.2).
 * Hashlock, ChaCha20, HKDF wrap key, key commitment, indexed Merkle leaves,
 * and small amount helpers. Explicitly SHA-256 / ChaCha20 — not Poseidon.
 * No Ed25519 here (Marketplace identities cover signatures).
 */
import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.ts";
import { merklePath, merkleRoot, verifyMerklePath, merkleLeafHash } from "../core/rfc9162-merkle.ts";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of canonicalJson(value); used for deterministic ids and digests. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const MIN_PREIMAGE_BYTES = 16;

/** Domain-separated hashlock. Explicitly SHA-256, not Poseidon. */
export function swapHashlock(preimage: string, orderNonce: number | bigint, networkId: string): string {
  if (typeof orderNonce === "number" && (!Number.isSafeInteger(orderNonce) || orderNonce < 0)) throw new Error("SWAP_NONCE");
  if (typeof orderNonce === "bigint" && orderNonce < 0n) throw new Error("SWAP_NONCE");
  if (typeof preimage !== "string" || Buffer.byteLength(preimage) < MIN_PREIMAGE_BYTES) throw new Error("SWAP_PREIMAGE_WEAK");
  return sha256Hex(canonicalJson(["UEP-SWAP-HASHLOCK-v1", networkId, preimage, typeof orderNonce === "bigint" ? orderNonce.toString(10) : orderNonce]));
}

export function wrapKey(k: Buffer, networkId: string, orderId: string): Buffer {
  if (k.length !== 32) throw new Error("RELAY_KEY_LENGTH");
  const info = Buffer.from(canonicalJson(["UEP-RELAY-WRAP-v5", networkId, orderId]));
  return Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), info, 32));
}

/** RFC 8439 ChaCha20 via Node: 4-byte LE block counter + 12-byte nonce. */
export function chacha20(key: Buffer, blockCounter: number, nonce: Buffer, data: Buffer): Buffer {
  if (key.length !== 32) throw new Error("RELAY_KEY_LENGTH");
  if (nonce.length !== 12) throw new Error("RELAY_NONCE");
  if (!Number.isSafeInteger(blockCounter) || blockCounter < 0 || blockCounter > 0xffffffff) throw new Error("RELAY_COUNTER");
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(blockCounter, 0);
  nonce.copy(iv, 4);
  const cipher = createCipheriv("chacha20", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function keyCommit(orderId: string, k: Buffer): string {
  return sha256Hex(Buffer.concat([Buffer.from("UEP-RELAY-WRAPKEY-COMMIT-v5\0"), Buffer.from(orderId), Buffer.from([0]), k]));
}

/**
 * Leaf hash with index and length bound in as fixed-width big-endian fields.
 * Same shape as the incoming adapted-modules leaf (0x00 || index || len || chunk).
 */
export function leafHash(index: number, len: number, chunk: Buffer): Buffer {
  const head = Buffer.alloc(9);
  head[0] = 0x00;
  head.writeUInt32BE(index, 1);
  head.writeUInt32BE(len, 5);
  return createHash("sha256").update(Buffer.concat([head, chunk])).digest();
}

export { merklePath, merkleRoot, verifyMerklePath, merkleLeafHash };

export function mulDivFloor(a: bigint, b: bigint | number, d: bigint | number): bigint {
  const bb = typeof b === "bigint" ? b : BigInt(b);
  const dd = typeof d === "bigint" ? d : BigInt(d);
  if (dd <= 0n) throw new Error("DIV_ZERO");
  if (a < 0n || bb < 0n) throw new Error("AMOUNT_INVALID");
  return (a * bb) / dd;
}

export function assertHex32(value: unknown, label = "hex"): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label.toUpperCase()}_INVALID`);
}

export function assertPositiveBigint(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`AMOUNT_INVALID: ${label}`);
}

export function assertNonNegInt(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label.toUpperCase()}_INVALID`);
}
