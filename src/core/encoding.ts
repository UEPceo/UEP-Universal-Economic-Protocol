/**
 * Canonical encoding for UEP objects.
 * Status: IMPLEMENTED (provisional until the core freezes a serialization spec)
 *
 * Field elements are 32-byte big-endian. Composite objects are hashed under
 * Domain.Transaction as a fold of their field encodings — not JSON, not SHA-256.
 */
import { Fr } from "./field.ts";
import { Domain, h, hFold } from "./hash.ts";

export const ENCODING_VERSION = 1;

export function u64ToFr(n: bigint): Fr {
  if (n < 0n || n >= 2n ** 64n) throw new Error("u64 out of range");
  return new Fr(n);
}

export function encodeStringToFr(s: string): Fr {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= 31) return Fr.fromBytesBE(bytes);
  // Fold 31-byte chunks under Transaction domain so long IDs stay in-field
  // without invoking SHA-256 on the protocol path.
  let acc = Fr.zero();
  for (let i = 0; i < bytes.length; i += 31) {
    const chunk = bytes.slice(i, i + 31);
    acc = h(Domain.Transaction, acc, Fr.fromBytesBE(chunk));
  }
  return acc;
}

export function canonicalTxCommitment(parts: Fr[]): Fr {
  return hFold(Domain.Transaction, [new Fr(ENCODING_VERSION), ...parts]);
}
