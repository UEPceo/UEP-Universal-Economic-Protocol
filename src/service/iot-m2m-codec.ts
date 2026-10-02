/**
 * Minimal canonical CBOR encoder for UEP IoT telemetry.
 *
 * It intentionally supports the data types used by the M2M envelope rather than
 * pretending to be a general-purpose CBOR implementation. Map keys are sorted
 * by their encoded bytes, matching deterministic/canonical CBOR ordering.
 */

function uint(major: number, value: number | bigint): Buffer {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 24n) return Buffer.from([(major << 5) | Number(n)]);
  if (n <= 0xffn) return Buffer.from([(major << 5) | 24, Number(n)]);
  if (n <= 0xffffn) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(Number(n), 1);
    return b;
  }
  if (n <= 0xffffffffn) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(n), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(n, 1);
  return b;
}

function text(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([uint(3, bytes.length), bytes]);
}

export function encodeCanonicalCbor(value: unknown): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (typeof value === "string") return text(value);
  if (typeof value === "bigint") {
    return value >= 0n ? uint(0, value) : uint(1, -1n - value);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      return value >= 0 ? uint(0, value) : uint(1, -1 - value);
    }
    const b = Buffer.alloc(9);
    b[0] = 0xfb;
    b.writeDoubleBE(value, 1);
    return b;
  }
  if (Array.isArray(value)) {
    return Buffer.concat([uint(4, value.length), ...value.map(encodeCanonicalCbor)]);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => ({ key: encodeCanonicalCbor(key), nested }))
      .sort((a, b) => Buffer.compare(a.key, b.key));
    const body = entries.flatMap(({ key, nested }) => [key, encodeCanonicalCbor(nested)]);
    return Buffer.concat([uint(5, entries.length), ...body]);
  }
  throw new TypeError(`CBOR_UNSUPPORTED_TYPE:${typeof value}`);
}
