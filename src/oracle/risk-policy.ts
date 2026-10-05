/**
 * Oracle market / risk policy helpers (v0.5.2). Pure evaluation: never moves
 * funds. Heights (ADR 0002). A SettlementAuthorization is a voucher for a
 * Marketplace or category guard to consume; the oracle does not settle.
 */
import { createHash } from "node:crypto";
import type { AggregatedQuote, EconomicEvaluation, SettlementAuthorization } from "./types.ts";
import { PPM_SCALE, PRICE_SCALE } from "./types.ts";
import { canonicalJson } from "../core/canonical-json.ts";

export interface TwapObservation {
  height: number;
  priceE6: bigint;
}

export class TwapTracker {
  private history = new Map<string, TwapObservation[]>();
  private readonly maxHistoryPoints: number;

  constructor(maxPoints = 120) {
    this.maxHistoryPoints = maxPoints;
  }

  private key(base: string, quote: string): string {
    return `${base}|${quote}`;
  }

  recordObservation(base: string, quote: string, priceE6: bigint, height: number): void {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("TWAP_HEIGHT_INVALID");
    const k = this.key(base, quote);
    const list = this.history.get(k) ?? [];
    if (list.length === 0 || height > list[list.length - 1]!.height) {
      list.push({ height, priceE6 });
      if (list.length > this.maxHistoryPoints) list.shift();
      this.history.set(k, list);
    }
  }

  /** TWAP over the last `windowHeights` blocks (default 60 ≈ 5 min). */
  computeTwap(base: string, quote: string, height: number, windowHeights = 60): bigint | undefined {
    const points = this.history.get(this.key(base, quote));
    if (!points || points.length < 2) return undefined;
    const windowStart = height - windowHeights;
    const inWindow = points.filter((p) => p.height >= windowStart);
    if (inWindow.length < 2) return inWindow[0]?.priceE6;

    let totalWeightedPrice = 0n;
    let totalTime = 0n;
    for (let i = 1; i < inWindow.length; i++) {
      const pPrev = inWindow[i - 1]!;
      const pCurr = inWindow[i]!;
      const dt = BigInt(pCurr.height - pPrev.height);
      totalWeightedPrice += pPrev.priceE6 * dt;
      totalTime += dt;
    }
    if (totalTime === 0n) return inWindow[inWindow.length - 1]!.priceE6;
    return totalWeightedPrice / totalTime;
  }
}

export function verifyAmmSpotSkew(
  amountIn: bigint,
  amountOut: bigint,
  oracleQuote: AggregatedQuote,
  isInputBase: boolean,
  maxAllowedSkewPpm: bigint = 30_000n,
): { ok: boolean; skewPpm?: bigint; message?: string } {
  if (amountIn <= 0n || amountOut <= 0n) return { ok: false, message: "Invalid swap amounts (must be positive)." };
  const effectivePriceE6 = isInputBase ? (amountOut * PRICE_SCALE) / amountIn : (amountIn * PRICE_SCALE) / amountOut;
  const oraclePriceE6 = oracleQuote.priceE6;
  if (oraclePriceE6 === 0n) return { ok: false, message: "Oracle reported zero price." };
  const diff = effectivePriceE6 > oraclePriceE6 ? effectivePriceE6 - oraclePriceE6 : oraclePriceE6 - effectivePriceE6;
  const skewPpm = (diff * PPM_SCALE) / oraclePriceE6;
  if (skewPpm > maxAllowedSkewPpm) {
    return { ok: false, skewPpm, message: `AMM skew ${skewPpm} PPM exceeds limit ${maxAllowedSkewPpm} PPM.` };
  }
  return { ok: true, skewPpm };
}

export function evaluateSvcSla(
  quote: AggregatedQuote,
  minPriceE6: bigint,
  height: number,
): EconomicEvaluation {
  const decision = quote.priceE6 >= minPriceE6 ? "ACCEPTED" : "REJECTED_BY_POLICY";
  return {
    decision,
    reason: decision === "ACCEPTED" ? undefined : `SLA price ${quote.priceE6} below floor ${minPriceE6}`,
    aggregatedQuote: quote,
    evaluatedAtHeight: height,
  };
}

export function evaluateIotTariff(
  quote: AggregatedQuote,
  units: bigint,
  maxCost: bigint,
  height: number,
): EconomicEvaluation {
  if (units < 0n || maxCost < 0n) {
    return { decision: "REJECTED_BY_POLICY", reason: "Invalid units or maxCost", aggregatedQuote: quote, evaluatedAtHeight: height };
  }
  const cost = (quote.priceE6 * units) / PRICE_SCALE;
  const decision = cost <= maxCost ? "ACCEPTED" : "REJECTED_BY_POLICY";
  return {
    decision,
    reason: decision === "ACCEPTED" ? undefined : `IoT cost ${cost} exceeds max ${maxCost}`,
    aggregatedQuote: quote,
    evaluatedAtHeight: height,
  };
}

export function evaluateDisputeEvidencePrice(
  quote: AggregatedQuote,
  claimedPriceE6: bigint,
  maxDeviationPpm: bigint,
  height: number,
): EconomicEvaluation {
  if (claimedPriceE6 <= 0n || quote.priceE6 <= 0n) {
    return { decision: "REJECTED_BY_POLICY", reason: "Non-positive price", aggregatedQuote: quote, evaluatedAtHeight: height };
  }
  const diff = claimedPriceE6 > quote.priceE6 ? claimedPriceE6 - quote.priceE6 : quote.priceE6 - claimedPriceE6;
  const ppm = (diff * PPM_SCALE) / quote.priceE6;
  const decision = ppm <= maxDeviationPpm ? "ACCEPTED" : "REJECTED_BY_POLICY";
  return {
    decision,
    reason: decision === "ACCEPTED" ? undefined : `Claimed price deviation ${ppm} PPM exceeds ${maxDeviationPpm}`,
    aggregatedQuote: quote,
    evaluatedAtHeight: height,
  };
}

/** Issue a single-use settlement voucher from an ACCEPTED evaluation. */
export function issueSettlementAuthorization(
  evaluation: EconomicEvaluation,
  params: {
    decisionId: string;
    contextId: string;
    authorizedAmount: bigint;
    recipientAddress: string;
    assetId: string;
    expiresAtHeight: number;
    nonce: string;
  },
): SettlementAuthorization {
  if (evaluation.decision !== "ACCEPTED") throw new Error("POLICY_REJECTED");
  if (typeof params.authorizedAmount !== "bigint" || params.authorizedAmount <= 0n) throw new Error("AMOUNT_INVALID");
  if (!Number.isSafeInteger(params.expiresAtHeight) || params.expiresAtHeight < evaluation.evaluatedAtHeight) {
    throw new Error("AUTH_EXPIRY_INVALID");
  }
  const policyHash = createHash("sha256")
    .update(canonicalJson(["UEP-ORACLE-POLICY-v1", evaluation.aggregatedQuote.priceE6, evaluation.aggregatedQuote.sourcesUsed, evaluation.evaluatedAtHeight]))
    .digest("hex");
  return {
    authorized: true,
    decisionId: params.decisionId,
    contextId: params.contextId,
    policyHash,
    authorizedAmount: params.authorizedAmount,
    recipientAddress: params.recipientAddress,
    assetId: params.assetId,
    issuedAtHeight: evaluation.evaluatedAtHeight,
    expiresAtHeight: params.expiresAtHeight,
    nonce: params.nonce,
  };
}

/** In-process single-use tracker for SettlementAuthorization nonces (test / guard helper). */
export class AuthorizationLedger {
  private used = new Set<string>();

  consume(auth: SettlementAuthorization, height: number): void {
    if (!auth.authorized) throw new Error("AUTH_INVALID");
    if (height > auth.expiresAtHeight) throw new Error("AUTH_EXPIRED");
    if (this.used.has(auth.nonce)) throw new Error("ALREADY_SETTLED");
    this.used.add(auth.nonce);
  }

  hasUsed(nonce: string): boolean {
    return this.used.has(nonce);
  }
}
