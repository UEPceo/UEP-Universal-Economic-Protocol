/**
 * v0.5.3 (Marketplace snapshot format 4): a deterministic, JSON-safe codec for
 * the Marketplace's mutable state (balances, listings, orders, escrow holds,
 * deposits, provider bonds, category holds, treasury, paymaster, evidence
 * exposure, idempotency and replay records).
 *
 * The encoding is tagged and unambiguous:
 *   bigint            -> { "$b": "<decimal>" }
 *   Map               -> { "$m": [[key, value], ...] }   (insertion order)
 *   Set               -> { "$s": [value, ...] }          (insertion order)
 *   NestedAmountMap   -> { "$n": [[outer, [[inner, "<decimal>"], ...]], ...] }
 *   bytes             -> { "$x": "<hex>" }
 *   Ed25519 public key (KeyObject) -> { "$k": "<spki hex>" }
 *   object with a key starting with "$" -> { "$o": { ... } }
 * Functions, private keys, symbols, non-finite numbers and class instances
 * other than the ones above are refused (MARKETPLACE_STATE_UNSERIALIZABLE),
 * so a field that cannot be restored is found when the snapshot is written,
 * not after a restart.
 *
 * Pure: no clock, no randomness, no environment.
 */
import { KeyObject } from "node:crypto";
import { NestedAmountMap } from "../core/composite-key.ts";
import { publicKeyHexOf, toPublicKey } from "../core/ed25519.ts";

export const MARKETPLACE_STATE_VERSION = 1;

function unserializable(path: string, what: string): never {
  throw new Error(`MARKETPLACE_STATE_UNSERIALIZABLE: ${path} (${what})`);
}

export function encodeStateValue(v: unknown, path = "$"): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      if (!Number.isFinite(v)) unserializable(path, "non-finite number");
      return v;
    case "bigint":
      return { $b: v.toString() };
    case "undefined":
      return null;
    case "function":
    case "symbol":
      return unserializable(path, typeof v);
  }
  if (Array.isArray(v)) return v.map((x, i) => encodeStateValue(x, `${path}[${i}]`));
  if (v instanceof Map) return { $m: [...v].map(([k, x]) => [encodeStateValue(k, `${path}.key`), encodeStateValue(x, `${path}.${String(k)}`)]) };
  if (v instanceof Set) return { $s: [...v].map((x, i) => encodeStateValue(x, `${path}{${i}}`)) };
  if (v instanceof NestedAmountMap) return { $n: v.outerKeys().map((o) => [o, v.entries(o).map(([i, a]) => [i, a.toString()])]) };
  if (v instanceof Uint8Array) return { $x: Buffer.from(v).toString("hex") };
  if (v instanceof KeyObject) {
    if (v.type !== "public") unserializable(path, "private key");
    return { $k: publicKeyHexOf(v) };
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) unserializable(path, (v as object).constructor?.name ?? "class instance");
  const out: Record<string, unknown> = {};
  let dollar = false;
  for (const key of Object.keys(v as object)) {
    const x = (v as Record<string, unknown>)[key];
    if (x === undefined) continue;
    if (key.startsWith("$")) dollar = true;
    out[key] = encodeStateValue(x, `${path}.${key}`);
  }
  return dollar ? { $o: out } : out;
}

export function decodeStateValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeStateValue);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const k = keys[0]!;
    const x = o[k];
    if (k === "$b" && typeof x === "string" && /^-?\d+$/.test(x)) return BigInt(x);
    if (k === "$m" && Array.isArray(x)) return new Map(x.map((e) => { if (!Array.isArray(e) || e.length !== 2) throw new Error("MARKETPLACE_STATE_INVALID: map entry"); return [decodeStateValue(e[0]), decodeStateValue(e[1])]; }));
    if (k === "$s" && Array.isArray(x)) return new Set(x.map(decodeStateValue));
    if (k === "$x" && typeof x === "string" && /^([0-9a-f]{2})*$/.test(x)) return Buffer.from(x, "hex");
    if (k === "$k" && typeof x === "string") return toPublicKey(x);
    if (k === "$n" && Array.isArray(x)) {
      const n = new NestedAmountMap();
      for (const e of x) {
        if (!Array.isArray(e) || typeof e[0] !== "string" || !Array.isArray(e[1])) throw new Error("MARKETPLACE_STATE_INVALID: nested amounts");
        for (const [inner, amount] of e[1] as unknown[][]) {
          if (typeof inner !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount) || amount === "0") throw new Error("MARKETPLACE_STATE_INVALID: nested amount");
          n.add(e[0], inner, BigInt(amount));
        }
      }
      return n;
    }
    if (k === "$o" && x && typeof x === "object" && !Array.isArray(x)) {
      const out: Record<string, unknown> = {};
      for (const [kk, vv] of Object.entries(x as Record<string, unknown>)) out[kk] = decodeStateValue(vv);
      return out;
    }
  }
  if (keys.some((k) => k.startsWith("$"))) throw new Error("MARKETPLACE_STATE_INVALID: unknown tag");
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decodeStateValue(o[k]);
  return out;
}

/** Encode the named fields of `owner` (a record of field name -> encoded value). */
export function captureFields(owner: object, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = encodeStateValue((owner as Record<string, unknown>)[name], name);
  return out;
}

/**
 * Restore the named fields of `owner` in place: Maps, Sets, arrays and
 * NestedAmountMaps keep their identity (cleared and refilled, so readonly
 * references held elsewhere stay valid); primitives are assigned.
 */
export function restoreFields(owner: object, names: readonly string[], data: Record<string, unknown>): void {
  if (!data || typeof data !== "object") throw new Error("MARKETPLACE_STATE_INVALID: section");
  const target = owner as Record<string, unknown>;
  for (const name of names) {
    if (!(name in data)) throw new Error(`MARKETPLACE_STATE_INVALID: missing ${name}`);
    const value = decodeStateValue(data[name]);
    const cur = target[name];
    if (cur instanceof Map) {
      if (!(value instanceof Map)) throw new Error(`MARKETPLACE_STATE_INVALID: ${name} is a map`);
      cur.clear();
      for (const [k, v] of value) cur.set(k, v);
    } else if (cur instanceof Set) {
      if (!(value instanceof Set)) throw new Error(`MARKETPLACE_STATE_INVALID: ${name} is a set`);
      cur.clear();
      for (const v of value) cur.add(v);
    } else if (cur instanceof NestedAmountMap) {
      if (!(value instanceof NestedAmountMap)) throw new Error(`MARKETPLACE_STATE_INVALID: ${name} is a nested amount map`);
      const inner = (cur as unknown as { byOuter: Map<string, Map<string, bigint>> }).byOuter;
      inner.clear();
      for (const o of value.outerKeys()) inner.set(o, new Map(value.entries(o)));
    } else if (Array.isArray(cur)) {
      if (!Array.isArray(value)) throw new Error(`MARKETPLACE_STATE_INVALID: ${name} is an array`);
      cur.length = 0;
      cur.push(...value);
    } else {
      if (cur !== undefined && cur !== null && typeof cur === "object") throw new Error(`MARKETPLACE_STATE_INVALID: ${name} cannot be restored`);
      if (cur !== undefined && value !== null && typeof value !== typeof cur) throw new Error(`MARKETPLACE_STATE_INVALID: ${name} type`);
      target[name] = value ?? undefined;
    }
  }
}
