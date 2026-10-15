/**
 * 0.5.83 Block A: signatures bound to network and domain (signed payload v2).
 *
 * A v2 signature covers, in one canonical, domain-separated message:
 *   networkId (ledger network), domainId (Marketplace id), signer identity,
 *   nonce, operation type, operation ids (target), operation details
 *   (amounts, hashes, ...) and a height window [validFromHeight, validUntilHeight].
 * The verifier rebuilds the message from ITS OWN networkId / domainId, so a
 * signature made for another network or domain never verifies. Nonces are
 * single-use per signer until the window closes (NonceRegistry; persisted in
 * the Marketplace snapshot, see marketplace-snapshot.ts).
 *
 * Legacy v1 (no network / nonce binding) is accepted only through the
 * deprecation shim LegacyV1Policy: explicit `{ sunsetHeight }`, a one-time
 * warning, and refusal at or after the sunset height. Under
 * NODE_ENV=production the shim is off unless configured explicitly.
 *
 * Time comes from block height only. No external dependency.
 */
import { stableStringify } from "../core/ed25519.ts";
import { isProductionEnvironment } from "../core/test-only.ts";

export const SIGNATURE_V2_ACTION_DOMAIN = "UEP-MARKETPLACE-ACTION-v2";
export const SIGNATURE_V2_RESERVE_DOMAIN = "UEP-MARKETPLACE-RESERVE-v2";
export const SIGNATURE_V2_IOT_DOMAIN = "UEP-IOT-TELEMETRY-v2";
/** Longest accepted v2 window (heights). Bounds the nonce registry. 17280 heights = 1 day at 5 s. */
export const MAX_V2_WINDOW_HEIGHTS = 17_280;
/** Default v1 shim length in non-production configurations: sunset = construction height + this (6_307_200 heights = 1 year at 5 s). */
export const DEFAULT_LEGACY_V1_SUNSET_HEIGHTS = 6_307_200;

/** Unsigned envelope fields of a v2 signature. */
export type SignatureEnvelopeV2 = { v: 2; nonce: string; validFromHeight: number; validUntilHeight: number };

export type BindingContext = { networkId: string; domainId: string };

export function actionMessageV2(ctx: BindingContext, a: { action: string; actorId: string; target: string; details?: Record<string, unknown> }, env: SignatureEnvelopeV2): string {
  return stableStringify({
    domain: SIGNATURE_V2_ACTION_DOMAIN,
    networkId: ctx.networkId,
    domainId: ctx.domainId,
    action: a.action,
    actorId: a.actorId,
    target: a.target,
    details: a.details ?? {},
    nonce: env.nonce,
    validFromHeight: env.validFromHeight,
    validUntilHeight: env.validUntilHeight,
  });
}

export function reservationMessageV2(ctx: BindingContext, r: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string; orderId?: string; gasQuoteId?: string }, env: SignatureEnvelopeV2): string {
  return stableStringify({
    domain: SIGNATURE_V2_RESERVE_DOMAIN,
    networkId: ctx.networkId,
    domainId: ctx.domainId,
    listingId: r.listingId,
    buyerId: r.buyerId,
    quantity: r.quantity.toString(),
    idempotencyKey: r.idempotencyKey,
    orderId: r.orderId ?? null,
    gasQuoteId: r.gasQuoteId ?? null,
    nonce: env.nonce,
    validFromHeight: env.validFromHeight,
    validUntilHeight: env.validUntilHeight,
  });
}

/** Structural and window checks of a v2 envelope at `height`. Throws SIGNATURE_V2_*. */
export function assertEnvelopeV2(env: unknown, height: number): asserts env is SignatureEnvelopeV2 {
  const e = env as Partial<SignatureEnvelopeV2> | undefined;
  if (!e || typeof e !== "object" || e.v !== 2) throw new Error("SIGNATURE_V2_ENVELOPE_INVALID");
  if (typeof e.nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(e.nonce)) throw new Error("SIGNATURE_V2_NONCE_INVALID");
  const from = e.validFromHeight, until = e.validUntilHeight;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || (from as number) < 0 || (until as number) < (from as number)) throw new Error("SIGNATURE_V2_WINDOW_INVALID");
  if ((until as number) - (from as number) > MAX_V2_WINDOW_HEIGHTS) throw new Error("SIGNATURE_V2_WINDOW_TOO_LONG");
  if (height < (from as number)) throw new Error("SIGNATURE_V2_NOT_YET_VALID");
  if (height > (until as number)) throw new Error("SIGNATURE_V2_EXPIRED");
}

/** Single-use nonces per signer, kept until their window closes. Deterministic, height-based pruning. */
export class NonceRegistry {
  #used = new Map<string, number>(); // `${signer}\u0000${nonce}` -> validUntilHeight

  static key(signer: string, nonce: string): string { return `${signer}\u0000${nonce}`; }

  has(signer: string, nonce: string): boolean { return this.#used.has(NonceRegistry.key(signer, nonce)); }

  /** Throws SIGNATURE_V2_NONCE_REUSED when the nonce was already consumed by this signer. */
  assertFresh(signer: string, nonce: string): void {
    if (this.has(signer, nonce)) throw new Error("SIGNATURE_V2_NONCE_REUSED");
  }

  consume(signer: string, nonce: string, validUntilHeight: number): void {
    this.assertFresh(signer, nonce);
    this.#used.set(NonceRegistry.key(signer, nonce), validUntilHeight);
  }

  /** Drop entries whose window closed before `height` (a replay is then refused as SIGNATURE_V2_EXPIRED). */
  prune(height: number): number {
    let n = 0;
    for (const [k, until] of this.#used) if (until < height) { this.#used.delete(k); n++; }
    return n;
  }

  get size(): number { return this.#used.size; }

  /** Snapshot form: sorted [signer, nonce, validUntilHeight] triples. */
  toJSON(): Array<[string, string, number]> {
    return [...this.#used.entries()].map(([k, u]) => { const i = k.indexOf("\u0000"); return [k.slice(0, i), k.slice(i + 1), u] as [string, string, number]; })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }

  static fromJSON(rows: unknown): NonceRegistry {
    const r = new NonceRegistry();
    if (rows === undefined || rows === null) return r; // migration: pre-0.5.83 snapshots carry no nonces
    if (!Array.isArray(rows)) throw new Error("SIGNATURE_V2_NONCES_INVALID");
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string" || !Number.isSafeInteger(row[2])) throw new Error("SIGNATURE_V2_NONCES_INVALID");
      r.#used.set(NonceRegistry.key(row[0], row[1]), row[2]);
    }
    return r;
  }
}

/** v1 deprecation shim. `false` refuses v1; `{ sunsetHeight }` accepts v1 strictly below it, with one warning. */
export type LegacyV1Config = false | { sunsetHeight: number; warn?: (message: string) => void };

export class LegacyV1Policy {
  readonly enabled: boolean;
  readonly sunsetHeight: number;
  readonly explicit: boolean;
  #warned = false;
  #warn: (m: string) => void;
  accepted = 0;

  constructor(config: LegacyV1Config | undefined, currentHeight = 0, unitsPerHeight = 1, production = isProductionEnvironment()) {
    if (config === false || (config === undefined && production)) {
      this.enabled = false; this.sunsetHeight = 0; this.explicit = config === false; this.#warn = () => {};
      return;
    }
    const c = config ?? { sunsetHeight: currentHeight + DEFAULT_LEGACY_V1_SUNSET_HEIGHTS * unitsPerHeight };
    if (!Number.isSafeInteger(c.sunsetHeight) || c.sunsetHeight < 0) throw new Error("LEGACY_V1_SUNSET_INVALID");
    this.enabled = true; this.sunsetHeight = c.sunsetHeight; this.explicit = config !== undefined;
    // Configuration time only. Pass `warn` to route or silence the one-time deprecation warning.
    const emit = typeof process !== "undefined" ? process.emitWarning.bind(process) : () => {};
    this.#warn = c.warn ?? ((m) => emit(m, "DeprecationWarning", "UEP_V1_SIGNATURE"));
  }

  /** Throws unless a v1 signature may still be accepted at `height`. */
  assertAllowed(kind: string, height: number): void {
    if (!this.enabled) throw new Error(`LEGACY_V1_SIGNATURE_REFUSED: ${kind} needs a v2 (network/domain/nonce bound) signature`);
    if (height >= this.sunsetHeight) throw new Error(`LEGACY_V1_SIGNATURE_SUNSET: v1 ${kind} signatures are refused from height ${this.sunsetHeight}`);
    this.accepted++;
    if (!this.#warned) { this.#warned = true; this.#warn(`UEP: legacy v1 ${kind} signature accepted under the deprecation shim (sunset height ${this.sunsetHeight}); sign v2 payloads`); }
  }
}
