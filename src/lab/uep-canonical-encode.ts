/**
 * Length-prefixed canonical encoding (reuses UEP-36.1 field encoding).
 * Avoids ambiguous join("|") for consensus-critical identifiers.
 */
import { createHash } from "node:crypto";
import { encodeField, encodeU32 } from "./uep36-digest-agg.ts";

export function canonicalFields(parts: string[]): Buffer {
  return Buffer.concat(parts.map((p) => encodeField(p)));
}

export function canonicalId(parts: string[], byteLen = 24): string {
  return createHash("sha256")
    .update(canonicalFields(parts))
    .digest("hex")
    .slice(0, byteLen);
}

/** Commitment over a set of strings (sorted UTF-8). */
export function setCommitment(ids: Iterable<string>): string {
  const sorted = [...ids].sort();
  const h = createHash("sha256");
  h.update(encodeU32(sorted.length));
  for (const id of sorted) h.update(encodeField(id));
  return h.digest("hex");
}
