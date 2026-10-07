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
  | "ALREADY_SETTLED"
  /** v0.5.3 (V-3): the quote names another network or domain than this verifier's local configuration. */
  | "DOMAIN_MISMATCH";

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
  /**
   * v0.5.3 (V-3): network this verifier serves. It is part of the signed
   * payload and of the domain separator, both taken from this local
   * configuration, never from the quote.
   */
  networkId: string;
  /**
   * v0.5.3 compatibility: also accept quotes signed over the v0.1 payload
   * (no networkId). Default false; meant only to re-verify archived quotes.
   */
  acceptLegacyV1Quotes: boolean;
  /**
   * v0.5.3 (V-4): maximum share of the total weight one key may carry in the
   * weighted median, in PPM (default 500_000 = half; a source's weight is cut
   * to the sum of the others' weights times this share / (1 - share)).
   */
  maxSourceWeightSharePpm: bigint;
  defaultMaxStalenessHeights: number;
  maxFutureDriftHeights: number;
  defaultMaxDeviationPpm: bigint;
  defaultMinSources: number;
  requireSignatures: boolean;
  useWeightedMedian: boolean;
}

/** Defaults: 12 heights (~60 s) staleness, 1 height future drift, 5 % deviation, 2 sources. */
export const DEFAULT_ORACLE_POLICY: OraclePolicy = {
  networkId: "uep-testnet-1",
  acceptLegacyV1Quotes: false,
  maxSourceWeightSharePpm: 500_000n,
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
  /** v0.5.3: height of the last explicit key rotation (rotateSourceKey). */
  keyRotatedAtHeight?: number;
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
  /** v0.5.3 (V-5): voucher format; "uep-settlement-authorization-v2" is signed. */
  version?: "uep-settlement-authorization-v2";
  networkId?: string;
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
  /** v0.5.3 (V-5): hash binding every field above (domain UEP-ORACLE-SETTLEMENT-AUTH-v2). */
  authorizationHash?: string;
  /** v0.5.3 (V-5): Ed25519 signature of `authorizationHash` by a policy authority key. */
  signature?: string;
  signerPublicKeyHex?: string;
}
