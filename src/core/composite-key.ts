/**
 * Injective composite keys for in-memory indexes (v0.4.7).
 *
 * `tupleKey(a, b, ...)` encodes an ordered tuple of strings with JSON string
 * escaping, so two different tuples never produce the same key, whatever
 * characters the parts contain. Use it wherever several caller-supplied
 * strings form one map key.
 * Status: IMPLEMENTED / TESTED
 */
export function tupleKey(...parts: string[]): string {
  for (const p of parts) if (typeof p !== "string") throw new Error("TUPLE_KEY_PART_INVALID");
  return JSON.stringify(parts);
}

/**
 * Two-level map (outer key -> inner key -> bigint). Totals per outer key never
 * mix entries of different outer keys. Zero entries are removed.
 */
export class NestedAmountMap {
  private readonly byOuter = new Map<string, Map<string, bigint>>();

  get(outer: string, inner: string): bigint {
    return this.byOuter.get(outer)?.get(inner) ?? 0n;
  }

  /** Add `delta` (may be negative). Throws ACCOUNTING_UNDERFLOW if the result would be negative. */
  add(outer: string, inner: string, delta: bigint): bigint {
    let m = this.byOuter.get(outer);
    const next = (m?.get(inner) ?? 0n) + delta;
    if (next < 0n) throw new Error("ACCOUNTING_UNDERFLOW");
    if (next === 0n) {
      if (m) {
        m.delete(inner);
        if (m.size === 0) this.byOuter.delete(outer);
      }
      return 0n;
    }
    if (!m) { m = new Map(); this.byOuter.set(outer, m); }
    m.set(inner, next);
    return next;
  }

  total(outer: string): bigint {
    let sum = 0n;
    for (const v of this.byOuter.get(outer)?.values() ?? []) sum += v;
    return sum;
  }

  outerKeys(): string[] {
    return [...this.byOuter.keys()];
  }

  entries(outer: string): Array<[string, bigint]> {
    return [...(this.byOuter.get(outer)?.entries() ?? [])];
  }
}
