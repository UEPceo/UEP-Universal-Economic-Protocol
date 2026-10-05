/**
 * Asset registry manifest (D-1 / D-3, ADR 0001).
 *
 * The list of assets a network accepts is a versioned manifest signed by a
 * governance key set. Admitting, re-keying or deprecating an asset is a
 * manifest version bump plus signatures, not a code change. Target design:
 * the ledger commits the hash of the manifest it runs in every snapshot (the
 * ledger integration is pending, see ADR 0001; this module is standalone).
 *
 * Model: registry -> asset definition -> authorized issuer key set ->
 * controlled issuance. Issuers cannot create assets: an asset exists only if
 * the governance-signed manifest lists it.
 *
 *  - Asset id: `<namespace>/<symbol>`, lowercase ASCII, at most 31 bytes, so
 *    the field encoding `encodeStringToFr` is injective over all valid ids
 *    (no two ids, whoever creates them, map to the same field element).
 *    Exception: ids under a v2 self-certifying namespace (`k-` + 26 base32
 *    characters, up to 44 bytes) use a packed encoding above 2^248 that is
 *    also injective and never meets a short id (`assetIdToFr`).
 *  - Namespace: owned by a key set (`owner`). Every asset under a namespace
 *    carries `approvals` by that owner over its admission message, so a
 *    namespace is bound to its owner's keys. Namespaces that start with `k-`
 *    are self-certifying: the name is derived from the owner key set. Since
 *    v0.5.1 new names carry 130 bits (`k-` + 26 base32 chars,
 *    domain `UEP-NAMESPACE-v2`); legacy 65-bit names (`k-` + 13 chars, domain
 *    `UEP-NAMESPACE-v1`) stay readable but cannot be newly admitted.
 *  - Issuer: each asset has its own issuer key set `{ keys, threshold }`.
 *    A mint needs `threshold` distinct valid signatures (threshold 1 today;
 *    M-of-N is the same code path). Issuer keys are never shared between
 *    assets and never equal a namespace-owner or governance key.
 *  - Amounts are u64 integers in the smallest unit; `decimals` is fixed per
 *    asset and at most 8.
 *  - `decimals`, `minProtocolFee`, `supplyCap`, `kind`, `symbol` and the
 *    namespace of an asset are immutable across manifest versions, so
 *    replaying history never depends on the manifest version (V47-04).
 *
 * Not implemented here (extension points, see ADR 0001): who may sign the
 * governance key set in a public phase, admission requirements, delisting
 * policy, and namespace registration for third parties.
 */
import type { KeyObject } from "node:crypto";
import { Fr } from "./field.ts";
import { encodeStringToFr } from "./encoding.ts";
import {
  generateEd25519KeyPair,
  publicKeyHexOf,
  sha256Hex,
  signEd25519,
  stableStringify,
  toPrivateKey,
  verifyEd25519,
  type PrivateKeyLike,
  type PublicKeyLike,
} from "./ed25519.ts";

export const ASSET_REGISTRY_FORMAT = "uep-asset-registry";
export const ASSET_REGISTRY_FORMAT_VERSION = 1;
/** D-1: maximum decimals of any asset. Raising it requires a protocol decision. */
export const MAX_ASSET_DECIMALS = 8;
export const U64_MAX = 2n ** 64n - 1n;
/** Namespace: a short name (1-15 chars) or a v2 self-certifying name (`k-` + 26 base32 chars). */
export const NAMESPACE_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,14}|k-[a-z2-7]{26})$/;
export const ASSET_SYMBOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,14}$/;
/**
 * Canonical asset id `<namespace>/<symbol>`: at most 31 bytes, or at most 44
 * bytes under a v2 self-certifying namespace (see `parseAssetId`).
 */
export const ASSET_ID_PATTERN = /^([a-z0-9][a-z0-9-]{0,14}|k-[a-z2-7]{26})\/([a-z0-9][a-z0-9._-]{0,14})$/;
/** Maximum byte length of an asset id under a short namespace (field-injective direct encoding). */
export const MAX_SHORT_ASSET_ID_BYTES = 31;
/** Prefix of self-certifying namespaces (`k-` + base32 of SHA-256 of the owner key set). */
export const SELF_CERTIFIED_NAMESPACE_PREFIX = "k-";
/** v0.5.1: base32 characters of a v2 self-certifying namespace (26 × 5 = 130 bits). */
export const SELF_CERTIFIED_NAMESPACE_CHARS = 26;
/** Legacy (v0.5.0) self-certifying namespaces: 13 base32 characters (65 bits). Read-only compatibility. */
export const LEGACY_SELF_CERTIFIED_NAMESPACE_CHARS = 13;
const SELF_CERTIFIED_V2_PATTERN = /^k-[a-z2-7]{26}$/;
const SELF_CERTIFIED_LEGACY_PATTERN = /^k-[a-z2-7]{13}$/;
export const ASSET_KINDS = ["test-currency", "resource-credit", "reserved", "simulation"] as const;
export const ASSET_STATUSES = ["experimental", "registered", "deprecated"] as const;
const MANIFEST_DOMAIN = "UEP-ASSET-REGISTRY-v1";
const ADMISSION_DOMAIN = "UEP-ASSET-ADMISSION-v1";

export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];
/** Threshold key set: `threshold` distinct valid signatures out of `keys` (hex SPKI DER). */
export type KeySet = { keys: string[]; threshold: number };
export type KeySetInput = { keys: PublicKeyLike[]; threshold?: number };
export type RegistrySignature = { publicKey: string; signature: string };
export type NamespaceRecord = { namespace: string; owner: KeySet; label?: string };
/**
 * Resource credits (tENERGY, tDATA): the physical measurement is evidence,
 * separate from the settlement asset. `evidence` names how a measurement is
 * attested (for example metered telemetry); it is not a balance.
 */
export type ResourceMeasurement = { quantity: string; unit: string; evidence: string };
export type AssetDefinition = {
  assetId: string;
  /** Display symbol; its lowercase form is the symbol part of the id. */
  symbol: string;
  name: string;
  kind: AssetKind;
  decimals: number;
  unit?: string;
  measurement?: ResourceMeasurement;
  metadata: string;
  status: AssetStatus;
  /** Minimum protocol fee in the smallest unit (decimal string, >= 1). */
  minProtocolFee: string;
  /** Maximum total issuance in the smallest unit (decimal string, <= u64 max). */
  supplyCap: string;
  issuer: KeySet;
  /** Namespace-owner signatures over `assetAdmissionMessage(networkId, asset)`. */
  approvals: RegistrySignature[];
};
export type AssetRegistryManifest = {
  format: typeof ASSET_REGISTRY_FORMAT;
  formatVersion: number;
  networkId: string;
  version: number;
  previousManifestHash: string | null;
  namespaces: NamespaceRecord[];
  assets: AssetDefinition[];
};
export type SignedAssetRegistry = AssetRegistryManifest & { manifestHash: string; signatures: RegistrySignature[] };

/** Runtime view of a registered asset. */
export type RegisteredAsset = Readonly<{
  assetId: string;
  namespace: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  decimals: number;
  unit?: string;
  measurement?: Readonly<ResourceMeasurement>;
  metadata: string;
  status: AssetStatus;
  minProtocolFee: bigint;
  supplyCap: bigint;
  issuer: Readonly<KeySet>;
  fr: Fr;
}>;

// ---------------------------------------------------------------- ids

export function parseAssetId(assetId: unknown): { namespace: string; symbol: string } {
  if (typeof assetId !== "string") throw new Error("ASSET_ID_INVALID: asset id must be a string");
  const m = ASSET_ID_PATTERN.exec(assetId);
  // Short namespaces keep the 31-byte bound (direct field encoding); v2 self-certifying ones are bounded by the pattern (≤ 44 bytes).
  if (!m || (!SELF_CERTIFIED_V2_PATTERN.test(m[1]!) && new TextEncoder().encode(assetId).length > MAX_SHORT_ASSET_ID_BYTES)) throw new Error("ASSET_ID_INVALID: asset ids must match <namespace>/<symbol> (" + ASSET_ID_PATTERN.source + ")");
  return { namespace: m[1]!, symbol: m[2]! };
}

export function isCanonicalAssetId(assetId: unknown): assetId is string {
  try {
    parseAssetId(assetId);
    return true;
  } catch {
    return false;
  }
}

const SYMBOL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789._-";
const PACKED_ID_TAG = 1n << 248n;

/**
 * Packed field encoding of an id under a v2 self-certifying namespace:
 * 2^248 + (130-bit namespace digest) * 2^80 + bijective base-40 symbol code
 * (< 40^15 < 2^80). Injective, below the BN254 modulus, and never equal to a
 * direct encoding of a short id (those are < 2^248).
 */
function packedSelfCertifiedAssetFr(namespace: string, symbol: string): Fr {
  let ns = 0n;
  for (const ch of namespace.slice(SELF_CERTIFIED_NAMESPACE_PREFIX.length)) ns = (ns << 5n) | BigInt(B32.indexOf(ch));
  let sym = 0n;
  let mul = 1n;
  for (const ch of symbol) {
    sym += BigInt(SYMBOL_ALPHABET.indexOf(ch) + 1) * mul;
    mul *= 40n;
  }
  return new Fr(PACKED_ID_TAG + (ns << 80n) + sym);
}

/**
 * Field encoding of a canonical asset id (injective over the grammar). Short
 * ids (≤ 31 bytes) keep the direct `encodeStringToFr` encoding, so every
 * existing id has the same field element as in v0.5.0.
 */
export function assetIdToFr(assetId: string): Fr {
  const { namespace, symbol } = parseAssetId(assetId);
  if (SELF_CERTIFIED_V2_PATTERN.test(namespace)) return packedSelfCertifiedAssetFr(namespace, symbol);
  return encodeStringToFr(assetId);
}

/** D-1 runtime check: integer decimals in [0, MAX_ASSET_DECIMALS]. */
export function assertAssetDecimals(decimals: unknown, context = "asset"): number {
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new Error(`ASSET_DECIMALS_INVALID: ${context} decimals must be an integer in [0, ${MAX_ASSET_DECIMALS}]`);
  }
  return decimals;
}

// ---------------------------------------------------------------- key sets

export function normalizeKeySet(ks: KeySetInput | KeySet | undefined, what: string): KeySet {
  if (!ks || !Array.isArray(ks.keys) || ks.keys.length === 0) throw new Error(`KEYSET_INVALID: ${what} needs at least one key`);
  const keys: string[] = [];
  for (const k of ks.keys) {
    let hex: string;
    try {
      hex = publicKeyHexOf(k);
    } catch {
      throw new Error(`KEYSET_INVALID: ${what} keys must be Ed25519 public keys`);
    }
    if (keys.includes(hex)) throw new Error(`KEYSET_INVALID: ${what} keys must be distinct`);
    keys.push(hex);
  }
  const threshold = ks.threshold ?? 1;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > keys.length) throw new Error(`KEYSET_INVALID: ${what} threshold must be between 1 and ${keys.length}`);
  return { keys, threshold };
}

/** Distinct keys of `ks` with a valid signature over `message`. Unknown or invalid signatures carry no weight. */
export function validSigners(message: string, signatures: RegistrySignature[] | undefined, ks: KeySet): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(signatures)) return out;
  for (const s of signatures) {
    if (!s || typeof s.publicKey !== "string" || typeof s.signature !== "string") continue;
    let hex: string;
    try {
      hex = publicKeyHexOf(s.publicKey);
    } catch {
      continue;
    }
    if (!ks.keys.includes(hex) || out.has(hex)) continue;
    if (verifyEd25519(message, s.signature, hex)) out.add(hex);
  }
  return out;
}

/** Real threshold verification: at least `ks.threshold` distinct valid signatures. */
export function meetsThreshold(message: string, signatures: RegistrySignature[] | undefined, ks: KeySet): boolean {
  return validSigners(message, signatures, ks).size >= ks.threshold;
}

export function signWith(message: string, keys: PrivateKeyLike[]): RegistrySignature[] {
  return keys.map((k) => ({ publicKey: publicKeyHexOf(toPrivateKey(k)), signature: signEd25519(message, k) }));
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function namespaceDigest(owner: KeySetInput | KeySet, domain: string): Buffer {
  const ks = normalizeKeySet(owner, "namespace owner");
  return Buffer.from(sha256Hex(stableStringify({ domain, keys: [...ks.keys].sort(), threshold: ks.threshold })), "hex");
}

/**
 * Self-certifying namespace of an owner key set: `k-` + 26 base32 chars
 * (130 bits) of SHA-256 over the canonical key set, domain `UEP-NAMESPACE-v2`.
 * Extension point for third-party namespaces: the name proves which keys own
 * it, so it cannot be squatted (v0.5.1: about 2^130 work for a
 * second preimage and 2^65 for a collision).
 */
export function selfCertifiedNamespace(owner: KeySetInput | KeySet): string {
  return SELF_CERTIFIED_NAMESPACE_PREFIX + base32(namespaceDigest(owner, "UEP-NAMESPACE-v2")).slice(0, SELF_CERTIFIED_NAMESPACE_CHARS);
}

/**
 * @deprecated Compatibility only. The v0.5.0 derivation: `k-` + 13 base32
 * chars (65 bits), domain `UEP-NAMESPACE-v1`. Too short for an open registry
 *. Manifests that already list such a name keep loading; new
 * manifests and version bumps cannot introduce one.
 */
export function legacySelfCertifiedNamespace(owner: KeySetInput | KeySet): string {
  return SELF_CERTIFIED_NAMESPACE_PREFIX + base32(namespaceDigest(owner, "UEP-NAMESPACE-v1")).slice(0, LEGACY_SELF_CERTIFIED_NAMESPACE_CHARS);
}

/** 2 for a v2 self-certifying name, 1 for a legacy (v0.5.0) one, null otherwise. */
export function selfCertifiedNamespaceVersion(namespace: string): 1 | 2 | null {
  if (SELF_CERTIFIED_V2_PATTERN.test(namespace)) return 2;
  if (SELF_CERTIFIED_LEGACY_PATTERN.test(namespace)) return 1;
  return null;
}

export function isLegacySelfCertifiedNamespace(namespace: string): boolean {
  return selfCertifiedNamespaceVersion(namespace) === 1;
}

/** True iff `namespace` is the self-certifying name (v2, or legacy v1) of `owner`. */
export function selfCertifiedNamespaceMatches(namespace: string, owner: KeySetInput | KeySet): boolean {
  const v = selfCertifiedNamespaceVersion(namespace);
  if (v === 2) return selfCertifiedNamespace(owner) === namespace;
  if (v === 1) return legacySelfCertifiedNamespace(owner) === namespace;
  return false;
}

// ---------------------------------------------------------------- messages / hashes

function definitionWithoutApprovals(a: AssetDefinition): Omit<AssetDefinition, "approvals"> {
  const { approvals: _a, ...rest } = a;
  return rest;
}

/** Message the namespace owner signs to admit an asset under its namespace. */
export function assetAdmissionMessage(networkId: string, asset: AssetDefinition | Omit<AssetDefinition, "approvals">): string {
  return stableStringify({ domain: ADMISSION_DOMAIN, networkId, asset: definitionWithoutApprovals(asset as AssetDefinition) });
}

function manifestBody(m: AssetRegistryManifest): AssetRegistryManifest {
  return {
    format: m.format,
    formatVersion: m.formatVersion,
    networkId: m.networkId,
    version: m.version,
    previousManifestHash: m.previousManifestHash,
    namespaces: m.namespaces,
    assets: m.assets,
  };
}

/** SHA-256 over the domain tag and the canonical manifest (without `manifestHash` / `signatures`). */
export function assetRegistryManifestHash(m: AssetRegistryManifest): string {
  return sha256Hex(`${MANIFEST_DOMAIN}\n${stableStringify(manifestBody(m))}`);
}

// ---------------------------------------------------------------- validation

const DEC = /^(0|[1-9][0-9]*)$/;
function u64String(v: unknown): bigint | undefined {
  if (typeof v !== "string" || !DEC.test(v)) return undefined;
  const n = BigInt(v);
  return n <= U64_MAX ? n : undefined;
}

/** Structural and approval checks of one manifest. Returns problems (empty when valid). */
export function validateAssetRegistryManifest(m: AssetRegistryManifest): string[] {
  const p: string[] = [];
  if (!m || typeof m !== "object") return ["manifest: not an object"];
  if (m.format !== ASSET_REGISTRY_FORMAT) p.push("manifest: format must be " + ASSET_REGISTRY_FORMAT);
  if (m.formatVersion !== ASSET_REGISTRY_FORMAT_VERSION) p.push(`manifest: formatVersion must be ${ASSET_REGISTRY_FORMAT_VERSION}`);
  if (typeof m.networkId !== "string" || m.networkId.length === 0) p.push("manifest: networkId required");
  if (!Number.isSafeInteger(m.version) || m.version < 1) p.push("manifest: version must be an integer >= 1");
  if (m.version === 1 ? m.previousManifestHash !== null : typeof m.previousManifestHash !== "string" || !/^[0-9a-f]{64}$/.test(m.previousManifestHash)) p.push("manifest: previousManifestHash must be null for version 1 and a SHA-256 hex otherwise");
  if (!Array.isArray(m.namespaces) || !Array.isArray(m.assets)) return [...p, "manifest: namespaces and assets must be arrays"];

  const owners = new Map<string, KeySet>();
  const ownerKeys = new Set<string>();
  for (const n of m.namespaces) {
    if (!n || typeof n.namespace !== "string" || !NAMESPACE_PATTERN.test(n.namespace)) { p.push(`namespace ${String(n?.namespace)}: invalid name`); continue; }
    if (owners.has(n.namespace)) { p.push(`namespace ${n.namespace}: duplicate`); continue; }
    let ks: KeySet;
    try { ks = normalizeKeySet(n.owner, `namespace ${n.namespace} owner`); } catch (e) { p.push((e as Error).message); continue; }
    if (ks.keys.join() !== n.owner.keys.join()) p.push(`namespace ${n.namespace}: owner keys must be canonical hex SPKI DER`);
    if (n.namespace.startsWith(SELF_CERTIFIED_NAMESPACE_PREFIX) && !selfCertifiedNamespaceMatches(n.namespace, ks)) p.push(`namespace ${n.namespace}: self-certifying name does not match its owner keys`);
    owners.set(n.namespace, ks);
    for (const k of ks.keys) ownerKeys.add(k);
  }

  const ids = new Set<string>();
  const encoded = new Set<string>();
  const issuerKeyOwner = new Map<string, string>();
  for (const a of m.assets) {
    if (!a || typeof a !== "object") { p.push("asset: not an object"); continue; }
    let parsed: { namespace: string; symbol: string };
    try { parsed = parseAssetId(a.assetId); } catch (e) { p.push(`${String(a.assetId)}: ${(e as Error).message}`); continue; }
    const id = a.assetId;
    if (ids.has(id)) p.push(`${id}: duplicate asset id`);
    ids.add(id);
    const hex = assetIdToFr(id).toHex();
    if (encoded.has(hex)) p.push(`${id}: field encoding collides`);
    encoded.add(hex);
    const owner = owners.get(parsed.namespace);
    if (!owner) p.push(`${id}: namespace ${parsed.namespace} is not registered`);
    if (typeof a.symbol !== "string" || a.symbol.toLowerCase() !== parsed.symbol) p.push(`${id}: symbol must match the id (lowercase)`);
    if (typeof a.name !== "string" || a.name.length === 0) p.push(`${id}: name required`);
    if (!ASSET_KINDS.includes(a.kind)) p.push(`${id}: unknown kind`);
    if (!ASSET_STATUSES.includes(a.status)) p.push(`${id}: unknown status`);
    try { assertAssetDecimals(a.decimals, id); } catch (e) { p.push((e as Error).message); }
    const fee = u64String(a.minProtocolFee);
    if (fee === undefined || fee < 1n) p.push(`${id}: minProtocolFee must be a decimal string in [1, u64 max]`);
    const cap = u64String(a.supplyCap);
    if (cap === undefined || cap < 1n) p.push(`${id}: supplyCap must be a decimal string in [1, u64 max]`);
    if (a.kind === "resource-credit") {
      const ms = a.measurement;
      if (!ms || typeof ms.quantity !== "string" || typeof ms.unit !== "string" || typeof ms.evidence !== "string" || !ms.quantity || !ms.unit || !ms.evidence) p.push(`${id}: resource-credit assets must describe their measurement (quantity, unit, evidence)`);
    }
    let issuer: KeySet | undefined;
    try { issuer = normalizeKeySet(a.issuer, `${id} issuer`); } catch (e) { p.push((e as Error).message); }
    if (issuer) {
      if (issuer.keys.join() !== a.issuer.keys.join()) p.push(`${id}: issuer keys must be canonical hex SPKI DER`);
      for (const k of issuer.keys) {
        const prev = issuerKeyOwner.get(k);
        if (prev && prev !== id) p.push(`${id}: issuer key is shared with ${prev}`);
        issuerKeyOwner.set(k, id);
        if (ownerKeys.has(k)) p.push(`${id}: issuer key must not be a namespace owner key`);
      }
    }
    if (owner && !meetsThreshold(assetAdmissionMessage(m.networkId, a), a.approvals, owner)) p.push(`${id}: missing namespace owner approval`);
  }
  return p;
}

/** Rules for a manifest version bump (`next` follows `prev`). Returns problems. */
export function validateAssetRegistryUpgrade(prev: SignedAssetRegistry, next: SignedAssetRegistry): string[] {
  const p: string[] = [];
  if (next.networkId !== prev.networkId) p.push("upgrade: networkId changed");
  if (next.version !== prev.version + 1) p.push("upgrade: version must increase by 1");
  if (next.previousManifestHash !== prev.manifestHash) p.push("upgrade: previousManifestHash must be the previous manifest hash");
  for (const n of prev.namespaces) if (!next.namespaces.some((x) => x.namespace === n.namespace)) p.push(`upgrade: namespace ${n.namespace} removed`);
  // legacy 65-bit self-certifying names stay readable but cannot be newly admitted.
  for (const n of next.namespaces) {
    if (isLegacySelfCertifiedNamespace(n.namespace) && !prev.namespaces.some((x) => x.namespace === n.namespace)) p.push(`upgrade: namespace ${n.namespace} is a legacy 65-bit self-certifying name and cannot be newly admitted (use selfCertifiedNamespace)`);
  }
  for (const a of prev.assets) {
    const b = next.assets.find((x) => x.assetId === a.assetId);
    if (!b) { p.push(`upgrade: asset ${a.assetId} removed (deprecate it instead)`); continue; }
    for (const f of ["symbol", "kind", "decimals", "minProtocolFee", "supplyCap", "unit"] as const) {
      if (a[f] !== b[f]) p.push(`upgrade: ${a.assetId} ${f} is immutable`);
    }
    if (stableStringify(a.measurement ?? null) !== stableStringify(b.measurement ?? null)) p.push(`upgrade: ${a.assetId} measurement is immutable`);
  }
  return p;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function cloneManifest(s: SignedAssetRegistry): SignedAssetRegistry {
  return JSON.parse(JSON.stringify(s)) as SignedAssetRegistry;
}

/**
 * Verify one signed manifest against the governance key set: structure,
 * approvals, hash, threshold signatures, and role separation (governance keys
 * are not issuer or namespace-owner keys). Returns a deep-frozen copy.
 */
export function verifySignedAssetRegistry(signed: SignedAssetRegistry, governance: KeySet): SignedAssetRegistry {
  if (!signed || typeof signed !== "object") throw new Error("ASSET_REGISTRY_INVALID: not an object");
  const problems = validateAssetRegistryManifest(signed);
  if (problems.length) throw new Error("ASSET_REGISTRY_INVALID: " + problems.join("; "));
  const hash = assetRegistryManifestHash(signed);
  if (signed.manifestHash !== hash) throw new Error("ASSET_REGISTRY_HASH: manifestHash does not match the manifest");
  for (const a of signed.assets) if (a.issuer.keys.some((k) => governance.keys.includes(k))) throw new Error("ASSET_REGISTRY_INVALID: governance keys must not be issuer keys");
  for (const n of signed.namespaces) if (n.owner.keys.some((k) => governance.keys.includes(k))) throw new Error("ASSET_REGISTRY_INVALID: governance keys must not be namespace owner keys");
  if (!meetsThreshold(hash, signed.signatures, governance)) throw new Error(`ASSET_REGISTRY_SIGNATURE: fewer than ${governance.threshold} valid governance signature(s)`);
  return deepFreeze(cloneManifest(signed));
}

// ---------------------------------------------------------------- runtime registry

function toRegistered(a: AssetDefinition): RegisteredAsset {
  const { namespace } = parseAssetId(a.assetId);
  return Object.freeze({
    assetId: a.assetId,
    namespace,
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
    decimals: assertAssetDecimals(a.decimals, a.assetId),
    unit: a.unit,
    measurement: a.measurement,
    metadata: a.metadata,
    status: a.status,
    minProtocolFee: BigInt(a.minProtocolFee),
    supplyCap: BigInt(a.supplyCap),
    issuer: a.issuer,
    fr: assetIdToFr(a.assetId),
  });
}

/**
 * Verified, immutable chain of manifest versions. The only way to obtain one
 * is `AssetRegistry.load()`, which checks every version and every upgrade.
 * There are no setters: a new version produces a new AssetRegistry.
 */
export class AssetRegistry {
  readonly governance: Readonly<KeySet>;
  readonly networkId: string;
  private readonly versions: readonly SignedAssetRegistry[];
  private readonly current: readonly RegisteredAsset[];
  private readonly byId: ReadonlyMap<string, RegisteredAsset>;
  private readonly byFr: ReadonlyMap<string, RegisteredAsset>;

  private constructor(versions: SignedAssetRegistry[], governance: KeySet) {
    this.versions = Object.freeze([...versions]);
    this.governance = Object.freeze({ keys: Object.freeze([...governance.keys]) as unknown as string[], threshold: governance.threshold });
    const last = versions[versions.length - 1]!;
    this.networkId = last.networkId;
    this.current = Object.freeze(last.assets.map(toRegistered));
    this.byId = new Map(this.current.map((a) => [a.assetId, a]));
    this.byFr = new Map(this.current.map((a) => [a.fr.toHex(), a]));
    Object.freeze(this);
  }

  static load(chain: SignedAssetRegistry | SignedAssetRegistry[], governance: KeySetInput | KeySet): AssetRegistry {
    const gov = normalizeKeySet(governance, "asset registry governance");
    const list = Array.isArray(chain) ? chain : [chain];
    if (list.length === 0) throw new Error("ASSET_REGISTRY_INVALID: empty manifest chain");
    const verified: SignedAssetRegistry[] = [];
    for (const [i, s] of list.entries()) {
      const v = verifySignedAssetRegistry(s, gov);
      if (i === 0 && v.version !== 1) throw new Error("ASSET_REGISTRY_CHAIN: the chain must start at version 1");
      if (i > 0) {
        const problems = validateAssetRegistryUpgrade(verified[i - 1]!, v);
        if (problems.length) throw new Error("ASSET_REGISTRY_CHAIN: " + problems.join("; "));
      }
      verified.push(v);
    }
    return new AssetRegistry(verified, gov);
  }

  /** Registry extended by a governance-signed version bump. `this` is unchanged. */
  withVersion(next: SignedAssetRegistry): AssetRegistry {
    return AssetRegistry.load([...this.versions, next], this.governance);
  }

  get version(): number {
    return this.versions[this.versions.length - 1]!.version;
  }
  /** Hash of the current manifest (committed in snapshots). */
  get hash(): string {
    return this.versions[this.versions.length - 1]!.manifestHash;
  }
  chain(): SignedAssetRegistry[] {
    return this.versions.map(cloneManifest);
  }
  list(): readonly RegisteredAsset[] {
    return this.current;
  }
  find(assetId: string): RegisteredAsset | undefined {
    return typeof assetId === "string" ? this.byId.get(assetId) : undefined;
  }
  findByFr(asset: Fr): RegisteredAsset | undefined {
    return this.byFr.get(asset.toHex());
  }
  /** Protocol fee floor of a registered asset (immutable across versions). */
  feeFloor(asset: Fr): bigint {
    const a = this.findByFr(asset);
    if (!a) throw new Error("ASSET_NOT_REGISTERED");
    return a.minProtocolFee;
  }
  /** Issuer key set of `assetId` in manifest `version` (undefined if absent). */
  issuerAt(version: number, assetId: string): KeySet | undefined {
    const v = this.versions.find((x) => x.version === version);
    return v?.assets.find((a) => a.assetId === assetId)?.issuer;
  }
  /** Every issuer key of every version (for key-separation checks). */
  allIssuerKeys(): Set<string> {
    const out = new Set<string>();
    for (const v of this.versions) for (const a of v.assets) for (const k of a.issuer.keys) out.add(k);
    return out;
  }
}

// ---------------------------------------------------------------- tooling

export type AssetDefinitionTemplate = Omit<AssetDefinition, "issuer" | "approvals" | "minProtocolFee" | "supplyCap"> & { minProtocolFee?: string; supplyCap?: string };

/**
 * Build and sign a manifest. Tooling for tests, local networks and governance
 * ceremonies; it needs the private keys it signs with.
 */
export function buildSignedAssetRegistry(opts: {
  networkId: string;
  version?: number;
  previous?: SignedAssetRegistry;
  namespaces: Array<{ namespace: string; owner: KeySetInput | KeySet; label?: string }>;
  assets: Array<AssetDefinitionTemplate & { issuer: KeySetInput | KeySet }>;
  namespaceOwnerKeys: Record<string, PrivateKeyLike[]>;
  governanceKeys: PrivateKeyLike[];
  /**
   * Compatibility only: allow legacy 65-bit `k-` names that are not
   * already in `previous`, for example to rebuild a v0.5.0 fixture.
   */
  allowLegacySelfCertifiedNamespaces?: boolean;
}): SignedAssetRegistry {
  const version = opts.version ?? (opts.previous ? opts.previous.version + 1 : 1);
  if (!opts.allowLegacySelfCertifiedNamespaces) {
    for (const n of opts.namespaces) {
      if (isLegacySelfCertifiedNamespace(n.namespace) && !opts.previous?.namespaces.some((x) => x.namespace === n.namespace)) {
        throw new Error(`ASSET_REGISTRY_LEGACY_NAMESPACE: ${n.namespace} is a legacy 65-bit self-certifying name; use selfCertifiedNamespace() (130 bits)`);
      }
    }
  }
  const namespaces: NamespaceRecord[] = opts.namespaces.map((n) => ({ namespace: n.namespace, owner: normalizeKeySet(n.owner, `namespace ${n.namespace} owner`), ...(n.label ? { label: n.label } : {}) }));
  const assets: AssetDefinition[] = opts.assets.map((t) => {
    const def: Omit<AssetDefinition, "approvals"> = {
      ...t,
      minProtocolFee: t.minProtocolFee ?? "1",
      supplyCap: t.supplyCap ?? U64_MAX.toString(),
      issuer: normalizeKeySet(t.issuer, `${t.assetId} issuer`),
    };
    const ns = parseAssetId(t.assetId).namespace;
    return { ...def, approvals: signWith(assetAdmissionMessage(opts.networkId, def), opts.namespaceOwnerKeys[ns] ?? []) };
  });
  const manifest: AssetRegistryManifest = {
    format: ASSET_REGISTRY_FORMAT,
    formatVersion: ASSET_REGISTRY_FORMAT_VERSION,
    networkId: opts.networkId,
    version,
    previousManifestHash: version === 1 ? null : opts.previous?.manifestHash ?? null,
    namespaces,
    assets,
  };
  const manifestHash = assetRegistryManifestHash(manifest);
  return { ...manifest, manifestHash, signatures: signWith(manifestHash, opts.governanceKeys) };
}

/** Add governance co-signatures (e.g. the second key of a 2-of-3 governance set). */
export function cosignAssetRegistry(signed: SignedAssetRegistry, keys: PrivateKeyLike[]): SignedAssetRegistry {
  return { ...signed, signatures: [...signed.signatures, ...signWith(signed.manifestHash, keys)] };
}

/**
 * Ephemeral development registry for a network: fresh governance,
 * namespace-owner and per-asset issuer keys, generated once per process and
 * never written anywhere. TEST / LOCAL ONLY. A real network supplies its own
 * signed manifest, governance public keys and issuer keys through the ledger
 * options (`assetRegistry`, `assetRegistryGovernance`, `issuerSigningKeys`).
 */
export type DevAssetRegistry = {
  chain: SignedAssetRegistry[];
  governance: KeySet;
  governanceKeys: KeyObject[];
  namespaceOwnerKeys: Record<string, KeyObject[]>;
  issuerKeys: Record<string, KeyObject[]>;
};

const devRegistries = new Map<string, DevAssetRegistry>();

export function buildDevAssetRegistry(networkId: string, templates: readonly AssetDefinitionTemplate[], namespaceLabels: Record<string, string> = {}): DevAssetRegistry {
  const governanceKeys = [generateEd25519KeyPair().privateKey];
  const namespaceOwnerKeys: Record<string, KeyObject[]> = {};
  for (const t of templates) {
    const ns = parseAssetId(t.assetId).namespace;
    namespaceOwnerKeys[ns] ??= [generateEd25519KeyPair().privateKey];
  }
  const issuerKeys: Record<string, KeyObject[]> = {};
  for (const t of templates) issuerKeys[t.assetId] = [generateEd25519KeyPair().privateKey];
  const chain = [
    buildSignedAssetRegistry({
      networkId,
      namespaces: Object.entries(namespaceOwnerKeys).map(([namespace, keys]) => ({ namespace, owner: { keys }, ...(namespaceLabels[namespace] ? { label: namespaceLabels[namespace] } : {}) })),
      assets: templates.map((t) => ({ ...t, issuer: { keys: issuerKeys[t.assetId]! } })),
      namespaceOwnerKeys,
      governanceKeys,
    }),
  ];
  return { chain, governance: normalizeKeySet({ keys: governanceKeys }, "governance"), governanceKeys, namespaceOwnerKeys, issuerKeys };
}

/** Process-wide cached ephemeral dev registry (see DevAssetRegistry). */
export function devAssetRegistryFor(networkId: string, templates: readonly AssetDefinitionTemplate[]): DevAssetRegistry {
  let r = devRegistries.get(networkId);
  if (!r) {
    r = buildDevAssetRegistry(networkId, templates);
    devRegistries.set(networkId, r);
  }
  return r;
}
