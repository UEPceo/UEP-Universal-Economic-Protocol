/**
 * Timing-safe helpers for UEP verifiers (MAC, hex digests).
 */
import { timingSafeEqual } from "node:crypto";

/** Compare two hex strings without leaking length of valid MAC via early exit on content. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const hex = /^[0-9a-fA-F]+$/;
  if (!hex.test(a) || !hex.test(b) || a.length !== b.length || a.length % 2 !== 0) return false;
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
