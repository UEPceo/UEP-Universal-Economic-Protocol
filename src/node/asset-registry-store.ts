/**
 * 0.5.83 Block D: persistent, versioned governance of the signed asset manifest.
 *
 * File `asset-registry.json` in the node state directory:
 *   { format: "uep-asset-registry-store", storeVersion: 1, networkId,
 *     governance: { keys, threshold }, chain: SignedAssetRegistry[], chainHash }
 * - `chain` is the full governance-signed manifest chain (version 1..n); on load
 *   every version is re-verified against `governance` and each upgrade against
 *   the previous one (AssetRegistry.load), and `chainHash` is recomputed.
 * - `governance` must equal the governance key set pinned by the network policy:
 *   a store signed by another key set is refused.
 * - Upgrades are governance-signed version bumps; the file is replaced atomically
 *   (tmp + fsync + rename + dir fsync). A store whose version is below the version
 *   bound by the ledger snapshot or the commit log is a regression and is refused.
 * - Migration: storeVersion 0 (a bare SignedAssetRegistry or a bare chain array,
 *   the pre-0.5.83 layout) is migrated to storeVersion 1 on load and re-written.
 *
 * The ledger snapshot already binds { networkId, version, hash } of the manifest
 * (UepLedger.assetRegistryBinding); this store keeps the chain that the binding
 * points to, across restarts. No real key ceremony is generated here: tests use
 * throwaway keys created in memory and marked TEST-ONLY.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AssetRegistry, normalizeKeySet, type KeySet, type KeySetInput, type SignedAssetRegistry } from "../core/asset-registry.ts";
import { sha256Hex, stableStringify } from "../core/ed25519.ts";

export const ASSET_REGISTRY_STORE_FORMAT = "uep-asset-registry-store";
export const ASSET_REGISTRY_STORE_VERSION = 1;
export const ASSET_REGISTRY_STORE_FILE = "asset-registry.json";

export type AssetRegistryStoreFile = {
  format: typeof ASSET_REGISTRY_STORE_FORMAT;
  storeVersion: 1;
  networkId: string;
  governance: KeySet;
  chain: SignedAssetRegistry[];
  chainHash: string;
};

/** Network policy for the asset registry of a reference node. */
export type NetworkRegistryPolicy = {
  networkId: string;
  /** When true a node refuses to operate without a valid registry for this network. */
  requireAssetRegistry: boolean;
  /**
   * 0.5.84: height from which the requirement applies (default 0: always, when requireAssetRegistry).
   * Lets a network announce the switch in advance (config/production-conditions.json).
   */
  requiredFromHeight?: number;
  /** Pinned governance key set (public keys only). */
  governance?: KeySetInput | KeySet;
};

export function registryChainHash(chain: readonly SignedAssetRegistry[]): string {
  return sha256Hex(`uep-asset-registry-chain-v1:${stableStringify(chain.map((m) => ({ version: m.version, manifestHash: m.manifestHash })))}`);
}

function sameKeySet(a: KeySet, b: KeySet): boolean {
  return a.threshold === b.threshold && JSON.stringify([...a.keys].sort()) === JSON.stringify([...b.keys].sort());
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not supported everywhere */ }
}

/** Migrate any known on-disk layout to storeVersion 1 (pure). */
export function migrateAssetRegistryStore(raw: unknown, governance: KeySet): AssetRegistryStoreFile {
  const r = raw as Record<string, unknown>;
  if (r && r.format === ASSET_REGISTRY_STORE_FORMAT) {
    if (r.storeVersion !== 1) throw new Error(`ASSET_REGISTRY_STORE_VERSION_UNSUPPORTED: ${String(r.storeVersion)}`);
    return r as unknown as AssetRegistryStoreFile;
  }
  // storeVersion 0: a bare signed manifest or a bare chain.
  const chain = Array.isArray(raw) ? (raw as SignedAssetRegistry[]) : r && typeof r === "object" && "manifestHash" in r ? [raw as SignedAssetRegistry] : null;
  if (!chain || chain.length === 0) throw new Error("ASSET_REGISTRY_STORE_CORRUPT: unknown layout");
  return { format: ASSET_REGISTRY_STORE_FORMAT, storeVersion: 1, networkId: chain[chain.length - 1]!.networkId, governance, chain, chainHash: registryChainHash(chain) };
}

export class AssetRegistryStore {
  readonly path: string;
  readonly governance: KeySet;
  readonly networkId: string;
  #registry: AssetRegistry | undefined;
  /** True when the file was migrated from an older layout during open. */
  readonly migratedFrom: number | null = null;

  private constructor(path: string, governance: KeySet, networkId: string, registry: AssetRegistry | undefined, migratedFrom: number | null) {
    this.path = path; this.governance = governance; this.networkId = networkId; this.#registry = registry; this.migratedFrom = migratedFrom;
  }

  /** Open (or prepare) the store in `stateDir`. Verifies governance, every signature, the upgrade chain and the chain hash. */
  static open(stateDir: string, policy: NetworkRegistryPolicy): AssetRegistryStore {
    const path = join(stateDir, ASSET_REGISTRY_STORE_FILE);
    if (!policy.governance) {
      if (policy.requireAssetRegistry) throw new Error("ASSET_REGISTRY_POLICY_INVALID: a network that requires the registry must pin its governance key set");
      return new AssetRegistryStore(path, { keys: [], threshold: 1 }, policy.networkId, undefined, null);
    }
    const gov = normalizeKeySet(policy.governance, "asset registry governance");
    if (!existsSync(path)) return new AssetRegistryStore(path, gov, policy.networkId, undefined, null);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("ASSET_REGISTRY_STORE_CORRUPT: not JSON"); }
    const wasCurrent = (raw as { format?: unknown })?.format === ASSET_REGISTRY_STORE_FORMAT;
    const file = migrateAssetRegistryStore(raw, gov);
    if (!sameKeySet(normalizeKeySet(file.governance, "store governance"), gov)) throw new Error("ASSET_REGISTRY_GOVERNANCE_MISMATCH: the store is governed by another key set than the network policy");
    if (file.networkId !== policy.networkId) throw new Error("ASSET_REGISTRY_NETWORK_MISMATCH");
    if (registryChainHash(file.chain) !== file.chainHash) throw new Error("ASSET_REGISTRY_STORE_CORRUPT: chain hash");
    const registry = AssetRegistry.load(file.chain, gov); // re-verifies every signature and upgrade
    if (registry.networkId !== policy.networkId) throw new Error("ASSET_REGISTRY_NETWORK_MISMATCH");
    const store = new AssetRegistryStore(path, gov, policy.networkId, registry, wasCurrent ? null : 0);
    if (!wasCurrent) store.#write(); // persist the migrated layout
    return store;
  }

  get registry(): AssetRegistry | undefined { return this.#registry; }
  get version(): number { return this.#registry?.version ?? 0; }

  /** Install the first chain (version 1..n), verified against the pinned governance. */
  install(chain: SignedAssetRegistry[]): AssetRegistry {
    if (this.#registry) throw new Error("ASSET_REGISTRY_ALREADY_INSTALLED: use upgrade()");
    const reg = AssetRegistry.load(chain, this.governance);
    if (reg.networkId !== this.networkId) throw new Error("ASSET_REGISTRY_NETWORK_MISMATCH");
    this.#registry = reg; this.#write();
    return reg;
  }

  /** Apply one governance-signed version bump (validated against the current version), then persist atomically. */
  upgrade(next: SignedAssetRegistry): AssetRegistry {
    if (!this.#registry) throw new Error("ASSET_REGISTRY_NOT_INSTALLED");
    const reg = this.#registry.withVersion(next);
    this.#registry = reg; this.#write();
    return reg;
  }

  /** Refuse a store that is behind what the ledger / commit log already bound (rollback of the file). */
  assertNotBehind(bound: { version: number; hash: string } | null | undefined): void {
    if (!bound) return;
    const reg = this.#registry;
    if (!reg) throw new Error("ASSET_REGISTRY_REGRESSION: the ledger binds a registry the store does not have");
    const at = reg.chain().find((m) => m.version === bound.version);
    if (reg.version < bound.version || !at || at.manifestHash !== bound.hash) throw new Error("ASSET_REGISTRY_REGRESSION: the store is behind or diverges from the bound registry");
  }

  #write(): void {
    const chain = this.#registry!.chain();
    const file: AssetRegistryStoreFile = { format: ASSET_REGISTRY_STORE_FORMAT, storeVersion: 1, networkId: this.networkId, governance: this.governance, chain, chainHash: registryChainHash(chain) };
    atomicWrite(this.path, JSON.stringify(file));
  }
}

/**
 * Reference-node gate: with `requireAssetRegistry` the node refuses to operate unless a valid,
 * governance-verified registry for its network is present (in the store, or already in the ledger).
 */
export function assertRegistryPolicy(policy: NetworkRegistryPolicy, registry: AssetRegistry | undefined, ledgerNetworkId: string, height?: number): void {
  if (policy.networkId !== ledgerNetworkId) throw new Error("NODE_REFUSES_TO_OPERATE: registry policy is for another network");
  if (!policy.requireAssetRegistry) return;
  // 0.5.84: before requiredFromHeight the registry is optional; without a height the requirement applies (conservative).
  if (height !== undefined && policy.requiredFromHeight !== undefined && height < policy.requiredFromHeight) return;
  if (!registry) throw new Error("NODE_REFUSES_TO_OPERATE: ASSET_REGISTRY_REQUIRED by the network policy and none is installed");
  if (registry.networkId !== ledgerNetworkId) throw new Error("NODE_REFUSES_TO_OPERATE: the asset registry belongs to another network");
  const gov = normalizeKeySet(policy.governance!, "asset registry governance");
  if (!sameKeySet(registry.governance as KeySet, gov)) throw new Error("NODE_REFUSES_TO_OPERATE: the asset registry is governed by another key set than the network policy");
}
