/**
 * Oracle quote verifier (v0.5.2). Synchronous Ed25519 via src/core/ed25519.ts.
 * Heights for freshness (ADR 0002). Strict public-key equality against the registry.
 */
import type { OraclePolicy, OracleQuote, SignedOracleQuote } from "./types.ts";
import { canonicalQuotePayload, assertCanonicalAssetPair } from "./canonical.ts";
import { OracleRegistry } from "./registry.ts";
import { publicKeyHexOf, verifyEd25519 } from "../core/ed25519.ts";

export class OracleVerifier {
  private registry: OracleRegistry;
  private lastSequences = new Map<string, bigint>();

  constructor(registry: OracleRegistry) {
    this.registry = registry;
  }

  private seqKey(source: string, base: string, quote: string): string {
    return `${source}:${base}:${quote}`;
  }

  clearSequenceCache(): void {
    this.lastSequences.clear();
  }

  /**
   * Verify a quote. `height` is the current Marketplace / TransitionClock height
   * (caller-supplied; the verifier never reads a wall clock).
   */
  verifyQuote(
    quote: OracleQuote | SignedOracleQuote,
    policy: OraclePolicy,
    height: number,
  ): { ok: true; verifiedQuote: OracleQuote | SignedOracleQuote } | { ok: false; code: string; message: string } {
    if (!Number.isSafeInteger(height) || height < 0) {
      return { ok: false, code: "INVALID_TIMESTAMP", message: "height must be a non-negative safe integer" };
    }

    try {
      assertCanonicalAssetPair(quote.baseAssetId, quote.quoteAssetId);
    } catch (err: unknown) {
      return { ok: false, code: "PAIR_UNKNOWN", message: err instanceof Error ? err.message : String(err) };
    }

    if (this.registry.isPairPaused(quote.baseAssetId, quote.quoteAssetId)) {
      return { ok: false, code: "PAIR_PAUSED", message: "Oracle feed for this pair is paused." };
    }

    if (quote.priceE6 <= 0n) {
      return { ok: false, code: "PRICE_OUT_OF_BOUNDS", message: "Price must be strictly positive." };
    }

    if (!Number.isSafeInteger(quote.observedAtHeight) || quote.observedAtHeight < 0) {
      return { ok: false, code: "INVALID_TIMESTAMP", message: "observedAtHeight is not a valid height." };
    }

    const regSource = this.registry.getSource(quote.source);
    if (regSource) {
      if (regSource.status === "SUSPENDED") {
        return { ok: false, code: "SOURCE_SUSPENDED", message: `Source '${quote.source}' is administratively SUSPENDED.` };
      }
      if (regSource.status === "REVOKED") {
        return { ok: false, code: "UNAUTHORIZED_SOURCE", message: `Source '${quote.source}' authorization has been REVOKED.` };
      }
    } else if (policy.requireSignatures) {
      return { ok: false, code: "UNAUTHORIZED_SOURCE", message: `Source '${quote.source}' is not registered in oracle registry.` };
    }

    const pairPolicy = this.registry.getPairPolicy(quote.baseAssetId, quote.quoteAssetId);
    const maxStaleness = pairPolicy?.maxStalenessHeights ?? policy.defaultMaxStalenessHeights;

    if (height - quote.observedAtHeight > maxStaleness) {
      return {
        ok: false,
        code: "STALE",
        message: `Quote observed ${height - quote.observedAtHeight} heights ago exceeds allowed staleness ${maxStaleness}.`,
      };
    }
    if (quote.observedAtHeight - height > policy.maxFutureDriftHeights) {
      return {
        ok: false,
        code: "INVALID_TIMESTAMP",
        message: `Quote height is ahead by ${quote.observedAtHeight - height} (drift limit: ${policy.maxFutureDriftHeights}).`,
      };
    }

    const sk = this.seqKey(quote.source, quote.baseAssetId, quote.quoteAssetId);
    const lastSeq = this.lastSequences.get(sk);
    if (lastSeq !== undefined && quote.sequence <= lastSeq) {
      return {
        ok: false,
        code: "REPLAY_ATTACK",
        message: `Duplicate or backwards sequence ${quote.sequence} <= ${lastSeq} for source ${quote.source}.`,
      };
    }

    if (policy.requireSignatures) {
      const signedQuote = quote as SignedOracleQuote;
      if (!signedQuote.signature || !signedQuote.signerPublicKeyHex) {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Signed quote missing signature or signer public key." };
      }

      let signerHex: string;
      try {
        signerHex = publicKeyHexOf(signedQuote.signerPublicKeyHex);
      } catch {
        return { ok: false, code: "INVALID_SIGNATURE", message: "Signer public key is not a valid Ed25519 key." };
      }

      if (regSource && signerHex !== regSource.publicKeyHex) {
        return {
          ok: false,
          code: "UNAUTHORIZED_SOURCE",
          message: `Signer public key does not match registered key for source '${quote.source}'.`,
        };
      }

      let payload: Uint8Array;
      try {
        payload = canonicalQuotePayload(signedQuote);
      } catch (err: unknown) {
        return { ok: false, code: "MALFORMED_ENCODING", message: err instanceof Error ? err.message : String(err) };
      }

      if (!verifyEd25519(payload, signedQuote.signature, signerHex)) {
        return { ok: false, code: "INVALID_SIGNATURE", message: `Cryptographic signature verification failed for source '${quote.source}'.` };
      }
    }

    this.lastSequences.set(sk, quote.sequence);
    return { ok: true, verifiedQuote: { ...quote, stage: "VERIFIED" } };
  }
}
