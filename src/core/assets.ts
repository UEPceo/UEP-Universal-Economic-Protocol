/**
 * Asset registry. Examples, not a closed list. No universal UEP coin.
 * Status: IMPLEMENTED (local registry). Live issuer attestations: CONCEPTUAL.
 *
 * v0.4.7: ledger asset ids follow a canonical grammar (`LEDGER_ASSET_ID_PATTERN`):
 * lowercase ASCII, at most 31 bytes, no leading NUL. Within that grammar the
 * field encoding `encodeStringToFr` is injective, so two registered asset ids
 * can never map to the same field element. The registry itself is checked by
 * `validateAssetRegistry()`. Opening the registry to arbitrary ids would need a
 * versioned, length-prefixed encoding (pending decision on the asset model).
 */
import { Fr } from "./field.ts";
import { encodeStringToFr } from "./encoding.ts";

export type AssetStatus = "experimental" | "registered" | "deprecated";

export type AssetRecord = {
  assetId: string;
  symbol: string;
  name: string;
  issuer: string;
  decimals: number;
  network: string;
  metadata: string;
  status: AssetStatus;
  unit?: string;
  /**
   * v0.4.7: minimum protocol fee for this asset, in its smallest unit (default
   * 1, the v0.4.4 floor). Part of the code-versioned registry, so every node
   * applies the same value. Must be >= 1. The 0.1% rate is not per asset.
   */
  minProtocolFee?: bigint;
};

/** Canonical ledger asset id: lowercase ASCII letters, digits and `.`, `_`, `:`, `-`; 1 to 31 bytes; starts with a letter or digit. */
export const LEDGER_ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,30}$/;
/** Maximum `decimals` accepted by `validateAssetRegistry()` (structural sanity bound, not a unit decision). */
export const MAX_REGISTRY_DECIMALS = 18;

export function isCanonicalLedgerAssetId(assetId: unknown): assetId is string {
  return typeof assetId === "string" && LEDGER_ASSET_ID_PATTERN.test(assetId);
}

/** Field encoding of a canonical ledger asset id. Throws ASSET_ID_INVALID otherwise. */
export function ledgerAssetIdToFr(assetId: string): Fr {
  if (!isCanonicalLedgerAssetId(assetId)) throw new Error("ASSET_ID_INVALID: ledger asset ids must match " + LEDGER_ASSET_ID_PATTERN.source);
  return encodeStringToFr(assetId);
}

/**
 * Structural checks of a registry: canonical and unique ids, distinct field
 * encodings, integer decimals in [0, MAX_REGISTRY_DECIMALS], minProtocolFee >= 1.
 * Returns the list of problems (empty when valid).
 */
export function validateAssetRegistry(records: AssetRecord[]): string[] {
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
    if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > MAX_REGISTRY_DECIMALS) problems.push(`${r.assetId}: decimals out of range`);
    if (r.minProtocolFee !== undefined && (typeof r.minProtocolFee !== "bigint" || r.minProtocolFee < 1n)) problems.push(`${r.assetId}: minProtocolFee must be a bigint >= 1`);
  }
  return problems;
}

export const TESTNET_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:test:eur",
    symbol: "tEUR",
    name: "Test Euro",
    issuer: "uep-testnet-faucet",
    decimals: 2,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not euros.",
    status: "experimental",
  },
  {
    assetId: "asset:test:btc",
    symbol: "tBTC",
    name: "Test Bitcoin",
    issuer: "uep-testnet-faucet",
    decimals: 8,
    network: "uep-testnet-1",
    metadata: "Experimental TESTNET unit. Not bitcoin.",
    status: "experimental",
  },
  {
    assetId: "asset:test:energy",
    symbol: "tENERGY",
    name: "Test Energy",
    issuer: "uep-testnet-faucet",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental kilowatt-hour credit.",
    status: "experimental",
    unit: "kWh",
  },
  {
    assetId: "asset:test:data",
    symbol: "tDATA",
    name: "Test Data",
    issuer: "uep-testnet-faucet",
    decimals: 0,
    network: "uep-testnet-1",
    metadata: "Experimental data credit.",
    status: "experimental",
    unit: "GB",
  },
];

export const GLOBAL_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:global:eur",
    symbol: "EUR",
    name: "Euro",
    issuer: "unconfigured",
    decimals: 2,
    network: "uep-global-1",
    metadata: "Reserved. No live GLOBAL issuer.",
    status: "registered",
  },
];

export const INTERPLANETARY_ASSETS: AssetRecord[] = [
  {
    assetId: "asset:ip:energy",
    symbol: "sENERGY",
    name: "Simulated Energy",
    issuer: "uep-interplanetary-sim",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "kWh",
  },
  {
    assetId: "asset:ip:compute",
    symbol: "sCOMPUTE",
    name: "Simulated Compute",
    issuer: "uep-interplanetary-sim",
    decimals: 0,
    network: "uep-interplanetary-1",
    metadata: "SIMULATION only.",
    status: "experimental",
    unit: "hours",
  },
];

export function assetsForNetwork(networkId: string): AssetRecord[] {
  if (networkId === "uep-testnet-1") return TESTNET_ASSETS;
  if (networkId === "uep-global-1") return GLOBAL_ASSETS;
  if (networkId === "uep-interplanetary-1") return INTERPLANETARY_ASSETS;
  return [];
}

export function findAsset(networkId: string, assetId: string): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => a.assetId === assetId);
}

/** Registered asset of a network by its field encoding. */
export function findAssetByFr(networkId: string, assetId: Fr): AssetRecord | undefined {
  return assetsForNetwork(networkId).find((a) => encodeStringToFr(a.assetId).eq(assetId));
}

export function formatAmount(amount: bigint, decimals: number): string {
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
