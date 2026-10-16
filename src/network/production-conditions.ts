/**
 * 0.5.84 item 4: production conditions per network type, from config/production-conditions.json.
 *
 *  - v1 signature sunset: "relative" (lab: construction height + N, the 0.5.83 default), "absolute"
 *    (testnet: one fixed height for every node, so a restart cannot move it), or "refused" (mainnet).
 *  - asset registry: when it becomes mandatory, by network type and height.
 *
 * A mainnet policy requires a pinned governance key set; until the governance key ceremony
 * (docs/GOVERNANCE-KEY-CEREMONY.md) has produced one, resolving the mainnet policy fails with
 * PRODUCTION_CONDITIONS_UNMET. Time is block height only.
 */
import type { LegacyV1Config } from "../marketplace/signature-v2.ts";
import type { NetworkRegistryPolicy } from "../node/asset-registry-store.ts";

export type NetworkKind = "lab" | "testnet" | "mainnet";
type V1Rule = { mode: "relative"; sunsetHeights: number } | { mode: "absolute"; sunsetHeight: number } | { mode: "refused" };
type RegistryRule = { required: false } | { required: true; requiredFromHeight: number };
export type ProductionConditions = {
  format: "uep-production-conditions";
  version: 1;
  networks: Record<NetworkKind, { v1Signatures: V1Rule; assetRegistry: RegistryRule }>;
};

const KINDS: NetworkKind[] = ["lab", "testnet", "mainnet"];
const height = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;

export function parseProductionConditions(raw: unknown): ProductionConditions {
  const c = raw as ProductionConditions;
  if (!c || c.format !== "uep-production-conditions" || c.version !== 1 || !c.networks) throw new Error("PRODUCTION_CONDITIONS_INVALID: format");
  for (const k of KINDS) {
    const n = c.networks[k];
    if (!n) throw new Error(`PRODUCTION_CONDITIONS_INVALID: missing ${k}`);
    const v = n.v1Signatures;
    if (!v || !(v.mode === "refused" || (v.mode === "absolute" && height(v.sunsetHeight)) || (v.mode === "relative" && height(v.sunsetHeights)))) throw new Error(`PRODUCTION_CONDITIONS_INVALID: ${k}.v1Signatures`);
    const r = n.assetRegistry;
    if (!r || !(r.required === false || (r.required === true && height(r.requiredFromHeight)))) throw new Error(`PRODUCTION_CONDITIONS_INVALID: ${k}.assetRegistry`);
  }
  if (c.networks.mainnet.v1Signatures.mode !== "refused") throw new Error("PRODUCTION_CONDITIONS_INVALID: mainnet must refuse v1 signatures");
  if (!c.networks.mainnet.assetRegistry.required) throw new Error("PRODUCTION_CONDITIONS_INVALID: mainnet must require the asset registry");
  return c;
}

/** Marketplace `legacyV1Signatures` option for a network type. */
export function legacyV1ConfigFor(kind: NetworkKind, c: ProductionConditions, currentHeight: number): LegacyV1Config {
  const v = c.networks[kind].v1Signatures;
  if (v.mode === "refused") return false;
  if (v.mode === "absolute") return { sunsetHeight: v.sunsetHeight };
  return { sunsetHeight: currentHeight + v.sunsetHeights };
}

/** Registry policy for a network type; mainnet needs the governance key set from the ceremony. */
export function registryPolicyFor(kind: NetworkKind, c: ProductionConditions, networkId: string, governance?: NetworkRegistryPolicy["governance"]): NetworkRegistryPolicy {
  const r = c.networks[kind].assetRegistry;
  if (!r.required) return { networkId, requireAssetRegistry: false, ...(governance ? { governance } : {}) };
  if (!governance) {
    if (kind === "mainnet") throw new Error("PRODUCTION_CONDITIONS_UNMET: mainnet requires the governance key set from the key ceremony");
    throw new Error(`PRODUCTION_CONDITIONS_UNMET: ${kind} requires a pinned governance key set from height ${r.requiredFromHeight}`);
  }
  return { networkId, requireAssetRegistry: true, requiredFromHeight: r.requiredFromHeight, governance };
}

/** v1 signature migration status at a height (for operators and the migration runbook). */
export function v1MigrationStatus(kind: NetworkKind, c: ProductionConditions, h: number, constructionHeight = 0): { accepted: boolean; sunsetHeight: number | null; heightsLeft: number | null } {
  const cfg = legacyV1ConfigFor(kind, c, constructionHeight);
  if (cfg === false) return { accepted: false, sunsetHeight: null, heightsLeft: null };
  return { accepted: h < cfg.sunsetHeight, sunsetHeight: cfg.sunsetHeight, heightsLeft: Math.max(0, cfg.sunsetHeight - h) };
}
