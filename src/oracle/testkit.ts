/**
 * Deterministic oracle test keys and quote helpers (v0.5.2).
 * Test-only: never used by production paths. No fake ledger / MockSettlementEngine.
 */
import { generateEd25519KeyPair, publicKeyHexOf, signEd25519, type PrivateKeyLike } from "../core/ed25519.ts";
import { canonicalQuotePayload, DOMAIN_SEPARATOR } from "./canonical.ts";
import type { OracleQuote, SignedOracleQuote } from "./types.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";

export type OracleTestKey = { sourceId: string; displayName: string; weight: number; publicKeyHex: string; privateKey: import("node:crypto").KeyObject };

export function createOracleTestKey(sourceId: string, displayName = sourceId, weight = 10): OracleTestKey {
  const { privateKey, publicKeyHex } = generateEd25519KeyPair();
  return { sourceId, displayName, weight, publicKeyHex, privateKey };
}

export function registerOracleTestKey(registry: OracleRegistry, key: OracleTestKey, height = 0): void {
  registry.registerSource({
    sourceId: key.sourceId,
    displayName: key.displayName,
    publicKeyHex: key.publicKeyHex,
    weight: key.weight,
    status: "ACTIVE",
    registeredAtHeight: height,
  });
}

let seq = 1n;

export function nextOracleSequence(): bigint {
  return seq++;
}

export function resetOracleSequence(start = 1n): void {
  seq = start;
}

export function makeQuote(input: {
  source: string;
  baseAssetId: string;
  quoteAssetId: string;
  priceE6: bigint;
  observedAtHeight: number;
  sequence?: bigint;
  contextId?: string;
}): OracleQuote {
  return {
    stage: "ATTESTED",
    baseAssetId: input.baseAssetId,
    quoteAssetId: input.quoteAssetId,
    priceE6: input.priceE6,
    source: input.source,
    sequence: input.sequence ?? nextOracleSequence(),
    observedAtHeight: input.observedAtHeight,
    contextId: input.contextId,
  };
}

export function signQuote(quote: OracleQuote, privateKey: PrivateKeyLike, publicKeyHex: string): SignedOracleQuote {
  const payload = canonicalQuotePayload(quote);
  return {
    ...quote,
    stage: "ATTESTED",
    signature: signEd25519(payload, privateKey),
    signerPublicKeyHex: publicKeyHexOf(publicKeyHex),
    domainSeparator: DOMAIN_SEPARATOR,
  };
}

/** Build a two-source aggregator with fresh test keys registered at height 0. */
export function freshAggregator(opts: { requireSignatures?: boolean; minSources?: number } = {}): {
  aggregator: OracleAggregator;
  keys: OracleTestKey[];
} {
  const registry = new OracleRegistry();
  const keys = [createOracleTestKey("src-a", "Source A", 10), createOracleTestKey("src-b", "Source B", 10)];
  for (const k of keys) registerOracleTestKey(registry, k, 0);
  const aggregator = new OracleAggregator(
    {
      requireSignatures: opts.requireSignatures ?? true,
      defaultMinSources: opts.minSources ?? 2,
      defaultMaxStalenessHeights: 12,
      maxFutureDriftHeights: 1,
    },
    registry,
  );
  return { aggregator, keys };
}
