/**
 * Asset definitions per network (ADR 0001). No universal UEP coin, no native token.
 *
 * v0.5.0: these records are the *templates* of each network's asset list.
 * The target authoritative list is the governance-signed asset registry
 * manifest (`src/core/asset-registry.ts`); wiring it into the ledger (with its
 * hash in every snapshot) is the next milestone (ADR 0001, "Pending").
 * The templates here seed the ephemeral development registry and give the
 * Marketplace and the network profiles their asset names; they are deep-frozen
 * and cannot be modified at runtime.
 *
 * Asset ids follow `<namespace>/<symbol>` (lowercase ASCII, at most 31 bytes),
 * so the field encoding is injective. Amounts are u64 integers in the smallest
 * unit; `decimals` is fixed per asset and at most 8 (D-1).
 */
import { Fr } from "./field.ts";
import { encodeStringToFr } from "./encoding.ts";
import { DEPRECATIONS, deprecate } from "./deprecation.ts";
import {
  ASSET_ID_PATTERN,
  MAX_ASSET_DECIMALS,
  assertAssetDecimals,
  assetIdToFr,
  devAssetRegistryFor,
  isCanonicalAssetId,
  type AssetDefinitionTemplate,
  type AssetKind,
  type DevAssetRegistry,
  type ResourceMeasurement,
} from "./asset-registry.ts";

export type AssetStatus = "experimental" | "registered" | "deprecated";

export type AssetRecord = {
  assetId: string;
  symbol: string;
  name: string;
  /** Issuer namespace (the part of the id before `/`). */
  issuer: string;
  kind: AssetKind;
  decimals: number;
  network: string;
  metadata: string;
  status: AssetStatus;
  unit?: string;
  /** Resource credits: the measured quantity is evidence, separate from the settlement asset. */
  measurement?: ResourceMeasurement;
  /**
   * Minimum protocol fee for this asset, in its smallest unit (default 1).
   * Immutable once the asset is admitted. The 0.1% rate is not per asset.
   */
  minProtocolFee?: bigint;
};

/** Canonical ledger asset id `<namespace>/<symbol>` (see asset-registry.ts). */
export const LEDGER_ASSET_ID_PATTERN = ASSET_ID_PATTERN;
/** D-1: maximum `decimals` of any asset (8). */
export const MAX_REGISTRY_DECIMALS = MAX_ASSET_DECIMALS;

export function isCanonicalLedgerAssetId(assetId: unknown): assetId is string {
  return isCanonicalAssetId(assetId);
}

/** Field encoding of a canonical ledger asset id (a legacy alias resolves first). Throws ASSET_ID_INVALID otherwise. */
export function ledgerAssetIdToFr(assetId: string): Fr {
  return assetIdToFr(resolveAssetIdAlias(assetId));
}

/**
 * Compatibility (docs/COMPATIBILITY.md): asset ids used before v0.5.0, mapped
 * to their `<namespace>/<symbol>` ids. Same asset, decimals and fee floor.
 *  - API inputs: a legacy id is resolved to the namespaced id (deprecated,
 *    warning `UEP_DEP_ASSET_ALIAS`). New notes always use the namespaced id.
 *  - Ledger state: notes, mints and spends created before the rename keep
 *    the field encoding of the legacy id (it is bound into commitments and
 *    signatures). That encoding is accepted as an alias encoding of the
 *    same asset; spends of such notes keep it (inputs, outputs and fee).
 * The table is append-only.
 */
export const LEGACY_ASSET_ID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "asset:test:eur": "uep-test/teur",
  "asset:test:btc": "uep-test/tbtc",
  "asset:test:energy": "uep-test/tenergy",
  "asset:test:data": "uep-test/tdata",
  "asset:global:eur": "uep-global/eur",
  "asset:ip:energy": "uep-sim/senergy",
  "asset:ip:compute": "uep-sim/scompute",
});

export function isLegacyAssetIdAlias(assetId: unknown): assetId is string {
  return typeof assetId === "string" && Object.prototype.hasOwnProperty.call(LEGACY_ASSET_ID_ALIASES, assetId);
}

/** Namespaced id of `assetId` (unchanged unless it is a legacy alias). */
export function resolveAssetIdAlias<T>(assetId: T): T {
  if (!isLegacyAssetIdAlias(assetId)) return assetId;
  deprecate(DEPRECATIONS.ASSET_ALIAS, `asset id "${assetId}" is a pre-v0.5.0 alias of "${LEGACY_ASSET_ID_ALIASES[assetId]}"; use the namespaced id`);
  return LEGACY_ASSET_ID_ALIASES[assetId] as T;
}

/** Legacy ids that alias `canonicalId`. */
export function legacyAliasesOf(canonicalId: string): string[] {
  return Object.keys(LEGACY_ASSET_ID_ALIASES).filter((k) => LEGACY_ASSET_ID_ALIASES[k] === canonicalId);
}

/** Field encodings accepted for an asset: the namespaced id first, then legacy aliases. */
export function assetEncodings(canonicalId: string): readonly Fr[] {
  let enc = encodingCache.get(canonicalId);
  if (!enc) {
    enc = Object.freeze([encodeStringToFr(canonicalId), ...legacyAliasesOf(canonicalId).map((a) => encodeStringToFr(a))]);
    encodingCache.set(canonicalId, enc);
  }
  return enc;
}
const encodingCache = new Map<string, readonly Fr[]>();
let legacyEncodingHexes: Set<string> | undefined;

/** True if `assetId` is the field encoding of a legacy alias (not of a namespaced id). */
export function isLegacyAssetEncoding(assetId: Fr): boolean {
  legacyEncodingHexes ??= new Set(Object.keys(LEGACY_ASSET_ID_ALIASES).map((a) => encodeStringToFr(a).toHex()));
  return legacyEncodingHexes.has(assetId.toHex());
}

/**
 * Structural checks of a list of asset records: canonical and unique ids,
 * distinct field encodings, integer decimals in [0, 8], minProtocolFee >= 1.
 * Returns the list of problems (empty when valid).
 */
export function validateAssetRegistry(records: readonly AssetRecord[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const encoded = new Set<string>();
  for (const r of records) {
    if (!isCanonicalLedgerAssetId(r.assetId)) { problems.push(`${r.assetId}: non-canonical asset id`); continue; }
    if (ids.has(r.assetId)) problems.push(`${r.assetId}: duplicate asset id`);
    ids.add(r.assetId);
    const hex = encodeStringToFr(r.assetId).toHex();
    if (encoded.has(hex)) problems.push(`${r.assetId}: field encoding collides`);
    encoded.add(hex);
    try { assertAssetDecimals(r.decimals, r.assetId); } catch { problems.push(`${r.assetId}: decimals out of range`); }
    if (r.minProtocolFee !== undefined && (typeof r.minProtocolFee !== "bigint" || r.minProtocolFee < 1n)) problems.push(`${r.assetId}: minProtocolFee must be a bigint >= 1`);
  }
  return problems;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export const TESTNET_ASSETS: readonly AssetRecord[] = deepFreeze([
  {
    assetId: "uep-test/teur",
    symbol: "tEUR",
    name: "Test Euro",
    issuer: "uep-test",
    kind: "test-currency",
    decimals: 2,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not euros.",
    status: "experimental",
  },
  {
    assetId: "uep-test/tbtc",
    symbol: "tBTC",
    name: "Test Bitcoin",
    issuer: "uep-test",
    kind: "test-currency",
    decimals: 8,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not bitcoin.",
    status: "experimental",
  },
  {
    assetId: "uep-test/tenergy",
    symbol: "tENERGY",
    name: "Test Energy",
    issuer: "uep-test",
    kind: "resource-credit",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental energy resource credit. The metered kWh are evidence; settlement may use another asset.",
    status: "experimental",
    unit: "kWh",
    measurement: { quantity: "energy", unit: "kWh", evidence: "metered telemetry" },
  },
  {
    assetId: "uep-test/tdata",
    symbol: "tDATA",
    name: "Test Data",
    issuer: "uep-test",
    kind: "resource-credit",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental data resource credit. The metered GB are evidence; settlement may use another asset.",
    status: "experimental",
    unit: "GB",
    measurement: { quantity: "data transfer", unit: "GB", evidence: "metered telemetry" },
  },
] as AssetRecord[]);

export const GLOBAL_ASSETS: readonly AssetRecord[] = deepFreeze([
  {
    assetId: "uep-global/eur",
    symbol: "EUR",
    name: "Euro",
    issuer: "uep-global",
    kind: "reserved",
    decimals: 2,
    network: "uep-global-1",
    metadata: "Reserved. No live GLOBAL issuer.",
    status: "registered",
  },
] as AssetRecord[]);

export const INTERPLANETARY_ASSETS: readonly AssetRecord[] = deepFreeze([
  {
    assetId: "uep-sim/senergy",
    symbol: "sENERGY",
    name: "Simulated Energy",
    issuer: "uep-sim",
    kind: "simulation",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "kWh",
  },
  {
    assetId: "uep-sim/scompute",
    symbol: "sCOMPUTE",
    name: "Simulated Compute",
    issuer: "uep-sim",
    kind: "simulation",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "hours",
  },
] as AssetRecord[]);

export function assetsForNetwork(networkId: string): readonly AssetRecord[] {
  if (networkId === "uep-testnet-1") return TESTNET_ASSETS;
  if (networkId === "uep-global-1") return GLOBAL_ASSETS;
  if (networkId === "uep-interplanetary-1") return INTERPLANETARY_ASSETS;
  return [];
}

/** Template asset of a network by id (a legacy alias resolves to its namespaced asset). */
export function findAsset(networkId: string, assetId: string): AssetRecord | undefined {
  const id = resolveAssetIdAlias(assetId);
  return assetsForNetwork(networkId).find((a) => a.assetId === id);
}

/** Template asset of a network by its field encoding (namespaced id or a legacy alias encoding). */
export function findAssetByFr(networkId: string, assetId: Fr): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => assetEncodings(a.assetId).some((e) => e.eq(assetId)));
}

/** Manifest templates (no keys) of a network's asset list. */
export function assetTemplatesForNetwork(networkId: string): AssetDefinitionTemplate[] {
  return assetsForNetwork(networkId).map((a) => ({
    assetId: a.assetId,
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
    decimals: a.decimals,
    ...(a.unit ? { unit: a.unit } : {}),
    ...(a.measurement ? { measurement: { ...a.measurement } } : {}),
    metadata: a.metadata,
    status: a.status,
    minProtocolFee: (a.minProtocolFee ?? 1n).toString(),
  }));
}

/**
 * Ephemeral development registry of a network (TEST / LOCAL ONLY; keys are
 * generated in memory once per process and never persisted).
 */
export function devAssetRegistry(networkId: string): DevAssetRegistry {
  return devAssetRegistryFor(networkId, assetTemplatesForNetwork(networkId));
}

export function formatAmount(amount: bigint, decimals: number): string {
  assertAssetDecimals(decimals, "formatAmount");
  if (decimals === 0) return amount.toString();
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}
