/**
 * Content identity — independent of storage locator.
 */

import { createHash } from "node:crypto";

export function contentHash(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyContentHash(
  bytes: Uint8Array | Buffer,
  expectedHex: string,
): { ok: true } | { ok: false; reason: string; actual: string } {
  const actual = contentHash(bytes);
  if (actual !== expectedHex.toLowerCase()) {
    return { ok: false, reason: "CONTENT_INTEGRITY_ERROR", actual };
  }
  return { ok: true };
}
