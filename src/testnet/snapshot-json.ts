/**
 * JSON form of ledger snapshots (docs/COMPATIBILITY.md).
 *
 * Snapshot payloads hold a few bigints (policy limits). `JSON.stringify`
 * cannot write them, so this codec writes a bigint as the string "<digits>n",
 * the same form `stableStringify` hashes. Encoding and decoding therefore do
 * not change `snapshotHash`, and signatures stay valid.
 */
const BIGINT_STRING = /^-?[0-9]+n$/;

export function snapshotToJSON(snapshot: unknown, space?: number): string {
  return JSON.stringify(snapshot, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), space);
}

export function snapshotFromJSON<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => (typeof v === "string" && BIGINT_STRING.test(v) ? BigInt(v.slice(0, -1)) : v)) as T;
}

/** Deep copy through the codec (revives "<digits>n" strings, e.g. in a fixture read with plain JSON.parse). */
export function reviveSnapshotBigints<T>(value: T): T {
  return snapshotFromJSON<T>(snapshotToJSON(value));
}
