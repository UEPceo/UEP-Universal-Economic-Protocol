/**
 * Ed25519 public-key point checks (RFC 8032 §5.1.3 decoding), pure BigInt.
 *
 * Used where a public key is registered rather than only used to verify a
 * signature (attester keys of evidence sets): the key must decode to a curve
 * point with a canonical encoding, in the prime-order subgroup. That rejects
 * the all-zero encoding, the identity, the small-order (torsion) points and
 * any 32 bytes that are not on the curve. Deterministic, no clock, no I/O.
 */
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint) => { const r = a % P; return r >= 0n ? r : r + P; };
function pow(b: bigint, e: bigint): bigint {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const D2 = mod(2n * D);
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Ext = [bigint, bigint, bigint, bigint]; // X, Y, Z, T

function add([x1, y1, z1, t1]: Ext, [x2, y2, z2, t2]: Ext): Ext {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * D2 * t2);
  const d = mod(2n * z1 * z2);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function double([x1, y1, z1]: Ext): Ext {
  const a = mod(x1 * x1);
  const b = mod(y1 * y1);
  const c = mod(2n * z1 * z1);
  const h = a + b;
  const e = mod(h - (x1 + y1) * (x1 + y1));
  const g = a - b;
  const f = c + g;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function mul(p: Ext, k: bigint): Ext {
  let r: Ext = [0n, 1n, 1n, 0n];
  let q = p;
  while (k > 0n) { if (k & 1n) r = add(r, q); q = double(q); k >>= 1n; }
  return r;
}

const isIdentity = ([x, y, z]: Ext) => mod(x) === 0n && mod(y - z) === 0n;

/** Decode a 32-byte encoding to an extended point, or undefined (non-canonical or not on the curve). */
function decode(bytes: Uint8Array): Ext | undefined {
  if (bytes.length !== 32) return undefined;
  const sign = bytes[31]! >> 7;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  if (y >= P) return undefined;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) { /* root found */ } else if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
  else return undefined;
  if (x === 0n && sign === 1) return undefined;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

/** True iff `raw` (32 bytes) is a canonical Ed25519 point of prime order (not zero, identity, small-order or off-curve). */
export function isPrimeOrderEd25519Point(raw: Uint8Array): boolean {
  const pt = decode(raw);
  if (!pt) return false;
  if (isIdentity(mul(pt, 8n))) return false; // identity or small order
  return isIdentity(mul(pt, L));
}

const RAW_SPKI_PREFIX = "302a300506032b6570032100";

/**
 * Normalize an Ed25519 public key given as 64 hex (raw) or SPKI DER hex to
 * 64 lowercase hex, and check it is a prime-order curve point. Returns
 * undefined if it is not.
 */
export function normalizeEd25519PublicKeyHex(key: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  let hex = key.trim().toLowerCase();
  if (hex.length === 88 && hex.startsWith(RAW_SPKI_PREFIX)) hex = hex.slice(RAW_SPKI_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
  return isPrimeOrderEd25519Point(Buffer.from(hex, "hex")) ? hex : undefined;
}

function invert(a: bigint): bigint {
  return pow(a, P - 2n);
}

function encode([x, y, z]: Ext): string {
  const zi = invert(z);
  const ax = mod(x * zi);
  let ay = mod(y * zi);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(ay & 0xffn); ay >>= 8n; }
  if (ax & 1n) out[31]! |= 0x80;
  return Buffer.from(out).toString("hex");
}

/**
 * The 8 small-order (torsion) points, as encodings with the sign bit cleared
 * (5 distinct values: points that differ only in the sign of x share one).
 * Computed once at load: L·P for the first decodable y with a full torsion
 * component generates the torsion subgroup.
 */
const SMALL_ORDER_MASKED: ReadonlySet<string> = (() => {
  for (let y = 2n; y < 1000n; y++) {
    const b = new Uint8Array(32);
    let v = y;
    for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    const p = decode(b);
    if (!p) continue;
    const t = mul(p, L);
    if (isIdentity(mul(t, 4n))) continue; // need order exactly 8
    const set = new Set<string>();
    let acc: Ext = [0n, 1n, 1n, 0n];
    for (let k = 0; k < 8; k++) {
      const enc = Buffer.from(encode(acc), "hex");
      enc[31]! &= 0x7f;
      set.add(enc.toString("hex"));
      acc = add(acc, t);
    }
    // identity (y=1), order 2 (y=-1), order 4 (y=0, both signs), order 8 (two y values, both signs).
    if (set.size !== 5) throw new Error("ED25519_TORSION_INIT");
    return set;
  }
  throw new Error("ED25519_TORSION_INIT");
})();

/**
 * v0.5.3: cheap check of a signature's R encoding (independent of the crypto
 * backend): canonical y (< p) and not one of the small-order points. A full
 * decode is left to the backend's verification equation.
 */
export function isAcceptableEd25519R(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const masked = Buffer.from(raw);
  masked[31]! &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(masked[i]!);
  if (y >= P) return false;
  return !SMALL_ORDER_MASKED.has(masked.toString("hex"));
}

/** v0.5.3: the signature scalar S (little-endian) is canonical: S < L. */
export function isCanonicalEd25519S(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(raw[i]!);
  return s < L;
}
