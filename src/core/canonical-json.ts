/**
 * Strict canonical JSON for values that are hashed or signed by the v0.5.2
 * settlement, category and oracle modules.
 *
 * Accepted: strings, booleans, null, safe integers, bigints, arrays and plain
 * objects. Rejected (CANON_*): floats, NaN / Infinity, unsafe integers,
 * undefined (also as an object value), functions, symbols, Buffers and other
 * class instances. Object keys are sorted by UTF-16 code unit; strings are
 * JSON-escaped, so no value can imitate a separator. Integers are written as
 * decimal digits whatever their JavaScript type (5 and 5n encode the same
 * value the same way).
 *
 * Why a second encoder: `stableStringify` (src/core/ed25519.ts) accepts
 * floats and is the byte format of signatures that existing clients already
 * produce (Marketplace actions, listings, IoT reports). Changing it would
 * invalidate those signatures, so it stays as it is and new hashed formats use
 * this strict encoder instead.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CANON_NUMBER: only safe integers (or bigint) are encoded");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("CANON_TYPE: only plain objects are encoded");
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) throw new Error("CANON_UNDEFINED");
      parts.push(`${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("CANON_TYPE");
}
