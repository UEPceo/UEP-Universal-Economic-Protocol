/**
 * Oracle source registry (v0.5.2). Administrative trust weights are not stake.
 * Heights for registration timestamps (ADR 0002). Strict public-key equality.
 */
import type { OraclePairPolicy, OracleSourceRegistration, OracleSourceStatus } from "./types.ts";
import { assertCanonicalAssetPair } from "./canonical.ts";
import { publicKeyHexOf } from "../core/ed25519.ts";

export class OracleRegistry {
  private sources = new Map<string, OracleSourceRegistration>();
  private pairPolicies = new Map<string, OraclePairPolicy>();
  private globalPaused = false;

  setGlobalPaused(paused: boolean): void {
    this.globalPaused = paused;
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  /**
   * Register a new source. v0.5.3 (V-1, V-2): a public key belongs to at most
   * one source id (ORACLE_SOURCE_KEY_IN_USE), and re-registering an existing
   * source id never changes its key silently: the same key only updates
   * metadata, a different key is refused (ORACLE_SOURCE_EXISTS; use
   * rotateSourceKey()).
   */
  registerSource(source: OracleSourceRegistration): void {
    if (!source.sourceId || source.sourceId.trim().length === 0) throw new Error("ORACLE_REGISTRY: Source ID cannot be empty");
    const publicKeyHex = this.normalizeKey(source.publicKeyHex);
    const existing = this.sources.get(source.sourceId);
    if (existing && existing.publicKeyHex !== publicKeyHex) throw new Error(`ORACLE_SOURCE_EXISTS: source '${source.sourceId}' is registered with another key; use rotateSourceKey()`);
    const owner = this.sourceIdOfKey(publicKeyHex);
    if (owner !== undefined && owner !== source.sourceId) throw new Error(`ORACLE_SOURCE_KEY_IN_USE: the key is already registered as source '${owner}'`);
    if (typeof source.weight !== "number" || !Number.isFinite(source.weight)) throw new Error("ORACLE_SOURCE_WEIGHT_INVALID");
    this.sources.set(source.sourceId, {
      ...source,
      publicKeyHex,
      weight: Math.max(1, Math.min(100, Math.trunc(source.weight))),
      status: source.status || "ACTIVE",
      registeredAtHeight: source.registeredAtHeight,
    });
  }

  /**
   * v0.5.3 (V-2): explicit key rotation of an existing source. The new key
   * must not belong to any source. Returns the previous key.
   */
  rotateSourceKey(sourceId: string, newPublicKeyHex: string, height: number): string {
    const src = this.sources.get(sourceId);
    if (!src) throw new Error("ORACLE_SOURCE_UNKNOWN");
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("ORACLE_ROTATION_HEIGHT_INVALID");
    const key = this.normalizeKey(newPublicKeyHex);
    if (key === src.publicKeyHex) throw new Error("ORACLE_ROTATION_SAME_KEY");
    const owner = this.sourceIdOfKey(key);
    if (owner !== undefined) throw new Error(`ORACLE_SOURCE_KEY_IN_USE: the key is already registered as source '${owner}'`);
    const previous = src.publicKeyHex;
    src.publicKeyHex = key;
    src.keyRotatedAtHeight = height;
    return previous;
  }

  /** Source id that owns `publicKeyHex` (canonical SPKI hex), if any. */
  sourceIdOfKey(publicKeyHex: string): string | undefined {
    for (const s of this.sources.values()) if (s.publicKeyHex === publicKeyHex) return s.sourceId;
    return undefined;
  }

  private normalizeKey(hex: string): string {
    // Normalize to the repository's canonical SPKI hex so equality checks are exact.
    try {
      return publicKeyHexOf(hex);
    } catch {
      throw new Error("ORACLE_REGISTRY: Invalid public key hex");
    }
  }

  getSource(sourceId: string): OracleSourceRegistration | undefined {
    const s = this.sources.get(sourceId);
    return s ? { ...s } : undefined;
  }

  getAllSources(): OracleSourceRegistration[] {
    return [...this.sources.values()].map((s) => ({ ...s }));
  }

  setSourceStatus(sourceId: string, status: OracleSourceStatus): void {
    const src = this.sources.get(sourceId);
    if (!src) return;
    src.status = status;
  }

  private pairKey(base: string, quote: string): string {
    return `${base}|${quote}`;
  }

  setPairPolicy(policy: OraclePairPolicy): void {
    assertCanonicalAssetPair(policy.baseAssetId, policy.quoteAssetId);
    if (!Number.isSafeInteger(policy.maxStalenessHeights) || policy.maxStalenessHeights < 1) throw new Error("ORACLE_STALENESS_INVALID");
    this.pairPolicies.set(this.pairKey(policy.baseAssetId, policy.quoteAssetId), { ...policy });
  }

  getPairPolicy(base: string, quote: string): OraclePairPolicy | undefined {
    const p = this.pairPolicies.get(this.pairKey(base, quote));
    return p ? { ...p } : undefined;
  }

  setPairPaused(base: string, quote: string, paused: boolean): void {
    const p = this.pairPolicies.get(this.pairKey(base, quote));
    if (p) {
      p.paused = paused;
    } else {
      this.setPairPolicy({
        baseAssetId: base,
        quoteAssetId: quote,
        maxStalenessHeights: 12,
        maxDeviationPpm: 50_000n,
        minSources: 1,
        paused,
      });
    }
  }

  isPairPaused(base: string, quote: string): boolean {
    if (this.globalPaused) return true;
    return this.pairPolicies.get(this.pairKey(base, quote))?.paused ?? false;
  }

  /** Record that a source was seen at `height` (after a successful publish). */
  touchSource(sourceId: string, height: number): void {
    const src = this.sources.get(sourceId);
    if (!src) return;
    if (!Number.isSafeInteger(height) || height < 0) return;
    src.lastSeenHeight = height;
  }
}
