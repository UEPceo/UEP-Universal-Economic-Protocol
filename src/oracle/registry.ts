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

  registerSource(source: OracleSourceRegistration): void {
    if (!source.sourceId || source.sourceId.trim().length === 0) throw new Error("ORACLE_REGISTRY: Source ID cannot be empty");
    // Normalize to the repository's canonical SPKI hex so equality checks are exact.
    let publicKeyHex: string;
    try {
      publicKeyHex = publicKeyHexOf(source.publicKeyHex);
    } catch {
      throw new Error("ORACLE_REGISTRY: Invalid public key hex");
    }
    this.sources.set(source.sourceId, {
      ...source,
      publicKeyHex,
      weight: Math.max(1, Math.min(100, source.weight)),
      status: source.status || "ACTIVE",
      registeredAtHeight: source.registeredAtHeight,
    });
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
