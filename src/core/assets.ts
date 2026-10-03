/**
 * Asset definitions per network (ADR 0001). No universal UEP coin, no native token.
 *
 * v0.4.8: these records are the *templates* of each network's asset list.
 * The authoritative list a ledger runs is the governance-signed asset registry
 * manifest (`src/core/asset-registry.ts`), whose hash every snapshot commits.
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

/** Field encoding of a canonical ledger asset id. Throws ASSET_ID_INVALID otherwise. */
export function ledgerAssetIdToFr(assetId: string): Fr {
  return assetIdToFr(assetId);
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

export function findAsset(networkId: string, assetId: string): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => a.assetId === assetId);
}

/** Template asset of a network by its field encoding. */
export function findAssetByFr(networkId: string, assetId: Fr): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => encodeStringToFr(a.assetId).eq(assetId));
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
