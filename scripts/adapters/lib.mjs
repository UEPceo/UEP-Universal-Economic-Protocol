// 0.5.83: shared helpers for OFF-NODE source adapters. Never imported by src/
// (npm run check:adapters). Nothing here touches the ledger, a transition or
// the node clock; the network is only used by the fetch helpers, and tests
// replace it with recorded fixtures.
import { createHash } from "node:crypto";

export const DEFAULT_TIMEOUT_MS = 10_000;

export class SourceError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

/** Fetch bytes with a hard timeout. Non-200 is "unavailable" (no evidence), never a partial answer. */
export async function fetchBytes(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new SourceError("SOURCE_CONFIG_INVALID", "timeoutMs");
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new SourceError("SOURCE_TIMEOUT", url)); }, timeoutMs); });
  let res;
  try {
    res = await Promise.race([fetchImpl(url, { signal: ctl.signal, redirect: "error", headers: { accept: "*/*" } }), timeout]);
    if (res.status === 200) res = { status: 200, buf: await Promise.race([res.arrayBuffer(), timeout]) };
  } catch (e) {
    if (e instanceof SourceError) throw e;
    if (ctl.signal.aborted) throw new SourceError("SOURCE_TIMEOUT", url);
    throw new SourceError("SOURCE_UNAVAILABLE", String(e?.message ?? e));
  } finally { clearTimeout(timer); timeout.catch(() => {}); }
  if (res.status !== 200) throw new SourceError("SOURCE_UNAVAILABLE", `HTTP ${res.status}`);
  return { url, status: 200, bytes: Buffer.from(res.buf) };
}

export const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Strict UTF-8 decode (invalid bytes are refused, not replaced). */
export function utf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new SourceError("SOURCE_MALFORMED", "invalid UTF-8"); }
}

export function parseJson(bytes) {
  try { return JSON.parse(utf8(bytes)); } catch (e) { if (e instanceof SourceError) throw e; throw new SourceError("SOURCE_MALFORMED", "invalid JSON"); }
}

/** Text fields: well-formed Unicode, NFC. No trimming, no case folding. */
export function nfc(s, field) {
  if (typeof s !== "string" || !s.isWellFormed()) throw new SourceError("SOURCE_MALFORMED", `${field}: not a well-formed string`);
  return s.normalize("NFC");
}

const DEC = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/;
/**
 * Decimal text (or a JSON number via its shortest round-trip text) to an
 * integer scaled by 10^scale, truncated toward zero. BigInt only: no float
 * arithmetic touches the value.
 */
export function scaled(v, scale, field) {
  let s;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new SourceError("SOURCE_MALFORMED", `${field}: not finite`); s = String(v); }
  else if (typeof v === "string") s = v;
  else throw new SourceError("SOURCE_MALFORMED", `${field}: not a number`);
  const m = DEC.exec(s);
  if (!m) throw new SourceError("SOURCE_MALFORMED", `${field}: ${JSON.stringify(s)}`);
  const digits = m[2] + (m[3] ?? "");
  const shift = scale - (m[3]?.length ?? 0) + Number(m[4] ?? 0);
  let n = BigInt(digits);
  if (shift >= 0) n *= 10n ** BigInt(shift); else n /= 10n ** BigInt(-shift);
  if (m[1] === "-") n = -n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new SourceError("SOURCE_MALFORMED", `${field}: out of range`);
  return Number(n) === 0 ? 0 : Number(n);
}

/** UTC ISO-8601 text (no zone = UTC, as both FDSN services document) to integer ms. */
export function isoUtcMs(s, field) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z?$/.exec(nfc(s, field));
  if (!m) throw new SourceError("SOURCE_MALFORMED", `${field}: ${JSON.stringify(s)}`);
  const ms = Number(((m[7] ?? "") + "000").slice(0, 3));
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  if (!Number.isSafeInteger(t)) throw new SourceError("SOURCE_MALFORMED", field);
  return t;
}

/** Lab adapters run only behind an explicit flag (UEP_LAB_SOURCES=1 or { lab: true }). */
export function requireLab(opts = {}) {
  if (opts.lab === true || process.env.UEP_LAB_SOURCES === "1") return;
  throw new SourceError("LAB_FLAG_REQUIRED", "lab-only source: set UEP_LAB_SOURCES=1 (never on a node or a deployed service)");
}
