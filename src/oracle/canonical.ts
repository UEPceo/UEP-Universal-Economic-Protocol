/**
 * Canonical encoding and Poseidon commitment for oracle quotes (v0.5.2).
 *
 * Ed25519 signing uses a length-prefixed binary payload. Commitments use the
 * repository Poseidon BN254 (src/core/poseidon.ts), not a homemade permutation.
 * Status: IMPLEMENTED (testnet reference).
 */
import { poseidon2, poseidonDomainHash } from "../core/poseidon.ts";
import { BN254_FR_MODULUS } from "../core/field.ts";
import type { OracleContextType, OracleQuote, SignedOracleQuote } from "./types.ts";

/** v0.1 domain separator (legacy payload without networkId; see canonicalQuotePayloadV1). */
export const DOMAIN_SEPARATOR = "UEP_ORACLE_QUOTE_v0.1";
/** v0.5.3 (V-3): quote payload v2 prefix; the full separator is `${QUOTE_DOMAIN_V2}|${networkId}`. */
export const QUOTE_DOMAIN_V2 = "UEP_ORACLE_QUOTE_v0.2";

/** Domain separator of quote payload v2 for a network, from LOCAL configuration (never from the quote). */
export function quoteDomainSeparator(networkId: string): string {
  if (typeof networkId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(networkId)) throw new Error("ORACLE_NETWORK_ID_INVALID");
  return `${QUOTE_DOMAIN_V2}|${networkId}`;
}
/** Poseidon domain tag for quote commitments (UEP-26 style domain composition). */
export const ORACLE_POSEIDON_DOMAIN = 0x4f52; // "OR"

export const LEDGER_ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._:\/-]{0,45}$/;

export function isCanonicalAssetId(id: unknown): id is string {
  return typeof id === "string" && LEDGER_ASSET_ID_PATTERN.test(id);
}

export function assertCanonicalAssetPair(base: string, quote: string): void {
  if (!isCanonicalAssetId(base)) throw new Error(`ASSET_ID_INVALID: Base asset '${base}' must match ${LEDGER_ASSET_ID_PATTERN.source}`);
  if (!isCanonicalAssetId(quote)) throw new Error(`ASSET_ID_INVALID: Quote asset '${quote}' must match ${LEDGER_ASSET_ID_PATTERN.source}`);
  if (base === quote) throw new Error("PAIR_INVALID: Base and quote assets cannot be identical");
}

export function validateFormalContextId(type: OracleContextType, contextId: string): boolean {
  if (!contextId || contextId.trim().length === 0 || contextId.length > 120) return false;
  switch (type) {
    case "SVC": return /^(svc:)?([a-z0-9._-]+)$/i.test(contextId);
    case "IOT": return /^iot:([a-z0-9._-]+):([a-z0-9._-]+)$/i.test(contextId);
    case "DISPUTE": return /^dispute:([a-z0-9._-]+):([a-z0-9._-]+)$/i.test(contextId);
    case "MARKET": return /^market:([a-z0-9._:\/-]+):([a-z0-9._:\/-]+)$/i.test(contextId);
    default: return false;
  }
}

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

/**
 * v0.5.3 (V-3) quote payload v2 for Ed25519 signing: the domain separator
 * `UEP_ORACLE_QUOTE_v0.2|<networkId>` and the networkId come from the
 * caller's local configuration; any `domainSeparator` carried by the quote is
 * ignored here (the verifier rejects a mismatching one).
 */
export function canonicalQuotePayload(quote: OracleQuote | SignedOracleQuote, ctx: { networkId: string }): Uint8Array {
  if (!ctx || typeof ctx.networkId !== "string") throw new Error("ORACLE_NETWORK_REQUIRED: canonicalQuotePayload(quote, { networkId })");
  const domain = quoteDomainSeparator(ctx.networkId);
  const net = new TextEncoder().encode(ctx.networkId);
  const body = encodeQuoteBody(quote, domain);
  const out = new Uint8Array(body.length + 1 + net.length);
  out.set(body, 0);
  out[body.length] = net.length;
  out.set(net, body.length + 1);
  return out;
}

/**
 * Legacy v0.1 payload (v0.5.2): fixed separator UEP_ORACLE_QUOTE_v0.1, no
 * networkId. Kept to re-verify archived quotes when the verifier opts in
 * (`acceptLegacyV1Quotes`); new quotes are signed over payload v2.
 */
export function canonicalQuotePayloadV1(quote: OracleQuote | SignedOracleQuote): Uint8Array {
  return encodeQuoteBody(quote, DOMAIN_SEPARATOR);
}

function encodeQuoteBody(quote: OracleQuote | SignedOracleQuote, domain: string): Uint8Array {
  if (quote.priceE6 < 0n || quote.priceE6 > MAX_UINT64) throw new Error("MALFORMED_ENCODING: priceE6 exceeds uint64 bounds");
  if (quote.sequence < 0n || quote.sequence > MAX_UINT64) throw new Error("MALFORMED_ENCODING: sequence exceeds uint64 bounds");
  if (!Number.isSafeInteger(quote.observedAtHeight) || quote.observedAtHeight < 0) {
    throw new Error("MALFORMED_ENCODING: observedAtHeight is not a valid height");
  }

  const enc = new TextEncoder();
  const domainBytes = enc.encode(domain);
  const baseBytes = enc.encode(quote.baseAssetId);
  const quoteBytes = enc.encode(quote.quoteAssetId);
  const sourceBytes = enc.encode(quote.source);
  const contextBytes = quote.contextId ? enc.encode(quote.contextId) : new Uint8Array(0);

  if ([domainBytes, baseBytes, quoteBytes, sourceBytes, contextBytes].some((b) => b.length > 255)) {
    throw new Error("MALFORMED_ENCODING: String length exceeds 255 bytes");
  }

  const totalLen = 1 + domainBytes.length + 1 + baseBytes.length + 1 + quoteBytes.length + 8 + 8 + 8 + 1 + sourceBytes.length + 1 + contextBytes.length;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 0;

  buf[offset++] = domainBytes.length;
  buf.set(domainBytes, offset);
  offset += domainBytes.length;
  buf[offset++] = baseBytes.length;
  buf.set(baseBytes, offset);
  offset += baseBytes.length;
  buf[offset++] = quoteBytes.length;
  buf.set(quoteBytes, offset);
  offset += quoteBytes.length;
  view.setBigUint64(offset, quote.priceE6, false);
  offset += 8;
  view.setBigUint64(offset, BigInt(quote.observedAtHeight), false);
  offset += 8;
  view.setBigUint64(offset, quote.sequence, false);
  offset += 8;
  buf[offset++] = sourceBytes.length;
  buf.set(sourceBytes, offset);
  offset += sourceBytes.length;
  buf[offset++] = contextBytes.length;
  if (contextBytes.length > 0) {
    buf.set(contextBytes, offset);
  }
  return buf;
}

export function bytesToFieldElement(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = 0; i < bytes.length; i++) acc = ((acc << 8n) | BigInt(bytes[i]!)) % BN254_FR_MODULUS;
  return acc;
}

/**
 * Poseidon commitment of a quote: domain-tagged composition of (base, quote)
 * and (price, height||sequence). Uses the repository Poseidon BN254.
 */
export function computeQuotePoseidonHash(quote: OracleQuote | SignedOracleQuote): bigint {
  const enc = new TextEncoder();
  const baseFr = bytesToFieldElement(enc.encode(quote.baseAssetId));
  const quoteFr = bytesToFieldElement(enc.encode(quote.quoteAssetId));
  const pairHash = poseidon2(baseFr, quoteFr);
  const priceFr = quote.priceE6 % BN254_FR_MODULUS;
  const timeSeqFr = (BigInt(quote.observedAtHeight) + (quote.sequence << 32n)) % BN254_FR_MODULUS;
  const timePriceHash = poseidon2(priceFr, timeSeqFr);
  return poseidonDomainHash(ORACLE_POSEIDON_DOMAIN, pairHash, timePriceHash);
}

export { BN254_FR_MODULUS as BN254_PRIME };
