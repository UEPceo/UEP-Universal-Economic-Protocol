/**
 * Oracle source registry (v0.5.2). Administrative trust weights are not stake.
 * Heights for registration timestamps (ADR 0002). Strict public-key equality.
 */
import type { OraclePairPolicy, OracleSourceRegistration, OracleSourceStatus } from "./types.ts";
import { assertCanonicalAssetPair } from "./canonical.ts";
import { isStrictEd25519PublicKey, publicKeyHexOf } from "../core/ed25519.ts";

export class OracleRegistry {
  private sources = new Map<string, OracleSourceRegistration>();
  private pairPolicies = new Map<string, OraclePairPolicy>();
  private globalPaused = false;
  private pausedPairs = new Set<string>();
  /** v0.5.3: keys rotated out or of revoked sources; never usable again by any source. */
  private retiredKeys = new Set<string>();

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
   * v0.5.3: re-registering with the same key updates metadata only: it can
   * change neither the weight nor the status (a revoked source stays
   * revoked). Keys must be prime-order Ed25519 points; a rotated-out or
   * revoked key can never be registered again (ORACLE_SOURCE_KEY_RETIRED).
   */
  registerSource(source: OracleSourceRegistration): void {
    if (!source.sourceId || source.sourceId.trim().length === 0) throw new Error("ORACLE_REGISTRY: Source ID cannot be empty");
    const publicKeyHex = this.normalizeKey(source.publicKeyHex);
    const existing = this.sources.get(source.sourceId);
    if (existing && existing.publicKeyHex !== publicKeyHex) throw new Error(`ORACLE_SOURCE_EXISTS: source '${source.sourceId}' is registered with another key; use rotateSourceKey()`);
    if (this.retiredKeys.has(publicKeyHex)) throw new Error("ORACLE_SOURCE_KEY_RETIRED: the key was rotated out or revoked");
    const owner = this.sourceIdOfKey(publicKeyHex);
    if (owner !== undefined && owner !== source.sourceId) throw new Error(`ORACLE_SOURCE_KEY_IN_USE: the key is already registered as source '${owner}'`);
    if (typeof source.weight !== "number" || !Number.isFinite(source.weight)) throw new Error("ORACLE_SOURCE_WEIGHT_INVALID");
    const weight = Math.max(1, Math.min(100, Math.trunc(source.weight)));
    if (existing) {
      if (weight !== existing.weight) throw new Error("ORACLE_SOURCE_EXISTS: re-registration cannot change the weight");
      if (source.status !== undefined && source.status !== existing.status) throw new Error("ORACLE_SOURCE_EXISTS: re-registration cannot change the status; use setSourceStatus()");
      this.sources.set(source.sourceId, { ...existing, ...source, publicKeyHex, weight: existing.weight, status: existing.status, registeredAtHeight: existing.registeredAtHeight, keyRotatedAtHeight: existing.keyRotatedAtHeight, lastSeenHeight: existing.lastSeenHeight });
      return;
    }
    this.sources.set(source.sourceId, {
      ...source,
      publicKeyHex,
      weight,
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
    if (src.status === "REVOKED") throw new Error("ORACLE_SOURCE_REVOKED");
    if (this.retiredKeys.has(key)) throw new Error("ORACLE_SOURCE_KEY_RETIRED: the key was rotated out or revoked");
    const owner = this.sourceIdOfKey(key);
    if (owner !== undefined) throw new Error(`ORACLE_SOURCE_KEY_IN_USE: the key is already registered as source '${owner}'`);
    const previous = src.publicKeyHex;
    // v0.5.3: the old key stops counting at rotation (quotes signed with it are ignored by the aggregator).
    this.retiredKeys.add(previous);
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
    let key: string;
    try {
      key = publicKeyHexOf(hex);
    } catch {
      throw new Error("ORACLE_REGISTRY: Invalid public key hex");
    }
    // v0.5.3: small-order, identity or off-curve keys are refused at registration.
    if (!isStrictEd25519PublicKey(key)) throw new Error("ORACLE_REGISTRY: public key is not a prime-order Ed25519 point");
    return key;
  }

  /** v0.5.3: true for a key that was rotated out or belonged to a revoked source. */
  isKeyRetired(publicKeyHex: string): boolean {
    try { return this.retiredKeys.has(publicKeyHexOf(publicKeyHex)); } catch { return false; }
  }

  getSource(sourceId: string): OracleSourceRegistration | undefined {
    const s = this.sources.get(sourceId);
    return s ? { ...s } : undefined;
  }

  getAllSources(): OracleSourceRegistration[] {
    return [...this.sources.values()].map((s) => ({ ...s }));
  }

  /**
   * Change a source's status. v0.5.3: REVOKED is final (its key is retired and
   * the source cannot be reactivated); SUSPENDED and ACTIVE switch freely. The
   * aggregator stops counting a non-ACTIVE source at once.
   */
  setSourceStatus(sourceId: string, status: OracleSourceStatus): void {
    const src = this.sources.get(sourceId);
    if (!src) return;
    if (status !== "ACTIVE" && status !== "SUSPENDED" && status !== "REVOKED") throw new Error("ORACLE_SOURCE_STATUS_INVALID");
    if (src.status === "REVOKED" && status !== "REVOKED") throw new Error("ORACLE_SOURCE_REVOKED: a revoked source cannot be reactivated");
    src.status = status;
    if (status === "REVOKED") this.retiredKeys.add(src.publicKeyHex);
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

  /**
   * Pause or resume one pair. v0.5.3: the pause is kept apart from pair
   * policies; pausing a pair that has no policy no longer creates one (a
   * pause must not change staleness, deviation or minimum-source rules).
   */
  setPairPaused(base: string, quote: string, paused: boolean): void {
    assertCanonicalAssetPair(base, quote);
    const key = this.pairKey(base, quote);
    if (paused) this.pausedPairs.add(key);
    else this.pausedPairs.delete(key);
    const p = this.pairPolicies.get(key);
    if (p) p.paused = paused;
  }

  isPairPaused(base: string, quote: string): boolean {
    if (this.globalPaused) return true;
    const key = this.pairKey(base, quote);
    return this.pausedPairs.has(key) || (this.pairPolicies.get(key)?.paused ?? false);
  }

  /** Record that a source was seen at `height` (after a successful publish). */
  touchSource(sourceId: string, height: number): void {
    const src = this.sources.get(sourceId);
    if (!src) return;
    if (!Number.isSafeInteger(height) || height < 0) return;
    src.lastSeenHeight = height;
  }
}
