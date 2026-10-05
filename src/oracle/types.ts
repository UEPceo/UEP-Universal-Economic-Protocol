/**
 * Oracle layer types (v0.5.2). Verifiable economic evidence for policy
 * evaluation only: SVC SLA, IoT tariff, dispute evidence, swap price checks.
 *
 * The oracle never holds a ledger or balance reference and is never queried
 * on the spend or consensus path. Heights (ADR 0002), amounts as bigint
 * (ADR 0001). Status: IMPLEMENTED (testnet reference).
 */
export const PRICE_SCALE = 1_000_000n;
export const PPM_SCALE = 1_000_000n;

export type EvidenceStage = "OBSERVED" | "ATTESTED" | "VERIFIED" | "AGGREGATED";
export type EconomicDecision = "ACCEPTED" | "REJECTED_BY_POLICY";
export type OracleContextType = "SVC" | "IOT" | "DISPUTE" | "MARKET";
export type OracleSourceStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export type OracleErrorCode =
  | "STALE"
  | "DEVIATION"
  | "NO_SOURCES"
  | "PAIR_UNKNOWN"
  | "INVALID_SIGNATURE"
  | "UNAUTHORIZED_SOURCE"
  | "SOURCE_SUSPENDED"
  | "REPLAY_ATTACK"
  | "INVALID_TIMESTAMP"
  | "PRICE_OUT_OF_BOUNDS"
  | "CANONICAL_HASH_MISMATCH"
  | "PAIR_PAUSED"
  | "MALFORMED_ENCODING"
  | "CROSS_CONTEXT_REPLAY"
  | "INVALID_CONTEXT_FORMAT"
  | "ALREADY_SETTLED";

export interface OracleQuote {
  stage: EvidenceStage;
  baseAssetId: string;
  quoteAssetId: string;
  priceE6: bigint;
  source: string;
  sequence: bigint;
  /** Block height at which the source observed the price (ADR 0002). */
  observedAtHeight: number;
  contextId?: string;
  attestation?: string;
}

export interface SignedOracleQuote extends OracleQuote {
  signature: string;
  signerPublicKeyHex: string;
  domainSeparator?: string;
  quoteHash?: string;
}

export interface AggregatedQuote {
  stage: "AGGREGATED";
  baseAssetId: string;
  quoteAssetId: string;
  priceE6: bigint;
  sourcesUsed: number;
  minPriceE6: bigint;
  maxPriceE6: bigint;
  observedAtHeight: number;
  aggregatedAtHeight: number;
  contextId?: string;
  sources: Array<{ source: string; priceE6: bigint; observedAtHeight: number; weight: number }>;
}

export type OracleReject =
  | { ok: false; code: OracleErrorCode; message: string }
  | { ok: true; quote: AggregatedQuote };

export interface OraclePairPolicy {
  baseAssetId: string;
  quoteAssetId: string;
  maxStalenessHeights: number;
  maxDeviationPpm: bigint;
  minSources: number;
  paused?: boolean;
}

export interface OraclePolicy {
  defaultMaxStalenessHeights: number;
  maxFutureDriftHeights: number;
  defaultMaxDeviationPpm: bigint;
  defaultMinSources: number;
  requireSignatures: boolean;
  useWeightedMedian: boolean;
}

/** Defaults: 12 heights (~60 s) staleness, 1 height future drift, 5 % deviation, 2 sources. */
export const DEFAULT_ORACLE_POLICY: OraclePolicy = {
  defaultMaxStalenessHeights: 12,
  maxFutureDriftHeights: 1,
  defaultMaxDeviationPpm: 50_000n,
  defaultMinSources: 2,
  requireSignatures: true,
  useWeightedMedian: true,
};

export interface OracleSourceRegistration {
  sourceId: string;
  displayName: string;
  publicKeyHex: string;
  weight: number;
  status: OracleSourceStatus;
  reputationMetadata?: { uptimeScore: number; totalReports: number; lastAuditHeight?: number };
  registeredAtHeight: number;
  lastSeenHeight?: number;
}

export interface EconomicEvaluation {
  decision: EconomicDecision;
  reason?: string;
  aggregatedQuote: AggregatedQuote;
  evaluatedAtHeight: number;
}

/**
 * Single-use voucher from a risk policy. The Marketplace / category guard that
 * consumes it must mark it used; the oracle itself never moves funds.
 */
export interface SettlementAuthorization {
  authorized: true;
  decisionId: string;
  contextId: string;
  policyHash: string;
  authorizedAmount: bigint;
  recipientAddress: string;
  assetId: string;
  issuedAtHeight: number;
  expiresAtHeight: number;
  nonce: string;
}
