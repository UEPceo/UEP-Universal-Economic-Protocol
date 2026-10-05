/**
 * UEP Marketplace Paymaster v0.1
 *
 * Gas is paid in the same asset as the purchase. There is no native UEP token
 * and no hidden FX conversion: the paymaster quotes a bounded gas amount,
 * reserves that amount, and recovers it from the buyer's escrow at settlement.
 * The buyer therefore sees one deterministic checkout total before payment.
 */
import { tupleKey } from "../core/composite-key.ts";
import { TransitionClock, type HeightSource } from "../core/height.ts";

export const PAYMASTER_VERSION = "0.1" as const;

export type GasQuote = {
  quoteId: string;
  asset: string;
  gasUnits: bigint;
  gasPricePerUnit: bigint;
  gasFee: bigint;
  quotedAt: number;
  expiresAt: number;
  maxSlippageBps: number;
  oracleRef: string;
};

export type PaymasterReceipt = {
  quoteId: string;
  orderId: string;
  asset: string;
  gasFee: bigint;
  capturedAt: number;
};

export type GasPriceOracle = (input: { asset: string; gasUnits: bigint; now: number }) => {
  gasPricePerUnit: bigint;
  oracleRef: string;
  maxSlippageBps?: number;
};

export type PaymasterConfig = {
  paymasterId?: string;
  /** Gas quote validity in heights (default 120 = 10 min at 5 s blocks). */
  quoteTtlHeights?: number;
  /** Legacy name: gas quote validity in ms (converted to heights; test-only ms clock: ms). */
  quoteTtlMs?: number;
  /**
   * Price source called by quote() only. quote() is not a state transition: the
   * quote is an input to reserve(). The oracle must not be called from a transition.
   */
  oracle?: GasPriceOracle;
  /** Block height source (ADR 0002), e.g. `() => ledger.height`. Required (or a test-only option); the Marketplace also passes its own height to every call. */
  height?: HeightSource;
  /** TEST-ONLY: a local height counter at 0. */
  testOnlyLocalHeight?: boolean;
  /** TEST-ONLY injected millisecond counter (never a real clock; removed in 0.6.0). */
  testOnlyNowMs?: () => number;
  /** @deprecated alias of `testOnlyNowMs`. */
  now?: () => number;
  /**
   * v0.5.0 reserve protection. An actor may hold at most
   * `maxOutstandingPerActor` open sponsorships (default 32) and at most
   * `maxActorShareBps` of the asset's sponsor capacity (reserve + outstanding;
   * default 2500 = 25%). One order may take at most `maxOrderShareBps` of the
   * capacity (default 1000 = 10%) and at most `maxGasPerOrder` (optional
   * absolute cap). Per-actor caps bind identities, so they rely on identities
   * being costly (registered keys, reservation deposits).
   */
  maxOutstandingPerActor?: number;
  maxActorShareBps?: number;
  maxOrderShareBps?: number;
  maxGasPerOrder?: bigint;
};

/** An open sponsorship: released automatically once `holdUntil` has passed unless pinned. */
type Sponsorship = { quote: GasQuote; orderId: string; actorId: string; holdUntil: number; pinned: boolean };

function quoteId(asset: string, gasUnits: bigint, at: number): string {
  return `gasq_${asset}_${gasUnits.toString()}_${at}`;
}

export class MarketplacePaymaster {
  readonly version = PAYMASTER_VERSION;
  readonly paymasterId: string;
  /** Quote validity in the paymaster's ticks (heights; ms with the test-only clock). */
  readonly quoteTtl: number;
  /** v0.5.1 (ADR 0002): time source (block heights by default). */
  readonly clock: TransitionClock;
  /** Nominal quote validity in ms (heights x 5 s; the injected ms with the test-only clock). */
  get quoteTtlMs(): number {
    return this.clock.toNominalMs(this.quoteTtl);
  }
  private readonly oracle: GasPriceOracle;
  private readonly now: () => number;
  private readonly reserves = new Map<string, bigint>();
  private readonly sponsored = new Map<string, Sponsorship>();
  private readonly captured = new Set<string>();
  /** Outstanding (sponsored, not captured / released) gas per asset and per actor+asset. */
  private readonly outstanding = new Map<string, bigint>();
  private readonly actorOutstanding = new Map<string, { count: number; amount: bigint }>();
  /** Min-heap of (holdUntil, key) for the expiry sweep; stale entries are skipped. */
  private readonly expiryHeap: { at: number; key: string }[] = [];
  readonly receipts: PaymasterReceipt[] = [];
  readonly maxOutstandingPerActor: number;
  readonly maxActorShareBps: number;
  readonly maxOrderShareBps: number;
  readonly maxGasPerOrder?: bigint;

  constructor(config: PaymasterConfig = {}) {
    this.paymasterId = config.paymasterId ?? "marketplace-paymaster";
    this.clock = TransitionClock.from(config);
    this.quoteTtl = this.clock.window("quoteTtl", config.quoteTtlHeights, config.quoteTtlMs, 120);
    if (!Number.isSafeInteger(this.quoteTtl) || this.quoteTtl <= 0) throw new Error("INVALID_QUOTE_TTL");
    this.maxOutstandingPerActor = config.maxOutstandingPerActor ?? 32;
    this.maxActorShareBps = config.maxActorShareBps ?? 2_500;
    this.maxOrderShareBps = config.maxOrderShareBps ?? 1_000;
    this.maxGasPerOrder = config.maxGasPerOrder;
    for (const [name, v] of [["maxActorShareBps", this.maxActorShareBps], ["maxOrderShareBps", this.maxOrderShareBps]] as const) {
      if (!Number.isInteger(v) || v <= 0 || v > 10_000) throw new Error(`INVALID_${name.toUpperCase()}`);
    }
    if (!Number.isInteger(this.maxOutstandingPerActor) || this.maxOutstandingPerActor <= 0) throw new Error("INVALID_MAX_OUTSTANDING_PER_ACTOR");
    this.now = () => this.clock.tick();
    this.oracle = config.oracle ?? (() => ({ gasPricePerUnit: 1n, oracleRef: "deterministic-local-gas", maxSlippageBps: 100 }));
  }

  fundReserve(asset: string, amount: bigint): void {
    if (!asset) throw new Error("ASSET_REQUIRED");
    if (amount <= 0n) throw new Error("INVALID_RESERVE_AMOUNT");
    this.reserves.set(asset, (this.reserves.get(asset) ?? 0n) + amount);
  }

  reserveOf(asset: string): bigint {
    return this.reserves.get(asset) ?? 0n;
  }

  quote(asset: string, gasUnits: bigint, now = this.now()): GasQuote {
    if (!asset) throw new Error("ASSET_REQUIRED");
    if (gasUnits <= 0n) throw new Error("INVALID_GAS_UNITS");
    const o = this.oracle({ asset, gasUnits, now });
    if (o.gasPricePerUnit < 0n) throw new Error("INVALID_GAS_PRICE");
    const gasFee = gasUnits * o.gasPricePerUnit;
    return {
      quoteId: quoteId(asset, gasUnits, now),
      asset,
      gasUnits,
      gasPricePerUnit: o.gasPricePerUnit,
      gasFee,
      quotedAt: now,
      expiresAt: now + this.quoteTtl,
      maxSlippageBps: o.maxSlippageBps ?? 100,
      oracleRef: o.oracleRef,
    };
  }

  /** Gas currently sponsored and not yet captured or released, for `asset`. */
  outstandingOf(asset: string): bigint {
    return this.outstanding.get(asset) ?? 0n;
  }

  /** Open sponsorships of `actorId` in `asset`. */
  actorOutstandingOf(actorId: string, asset: string): { count: number; amount: bigint } {
    const a = this.actorOutstanding.get(tupleKey(actorId, asset));
    return { count: a?.count ?? 0, amount: a?.amount ?? 0n };
  }

  /** Number of open sponsorships (all assets). */
  openSponsorships(): number {
    return this.sponsored.size;
  }

  /**
   * Reserve `quote.gasFee` for `orderId`. `actorId` is the buyer the caps are
   * charged to; `holdUntil` (default: quote expiry) is when an unpinned
   * sponsorship is released automatically. Expired sponsorships are swept
   * lazily before every new sponsorship.
   */
  sponsor(orderId: string, quote: GasQuote, now = this.now(), opts: { actorId?: string; holdUntil?: number } = {}): GasQuote {
    if (!orderId) throw new Error("ORDER_ID_REQUIRED");
    if (now > quote.expiresAt) throw new Error("GAS_QUOTE_EXPIRED");
    if (quote.gasFee < 0n || quote.gasUnits <= 0n || quote.gasPricePerUnit < 0n) throw new Error("INVALID_GAS_QUOTE");
    const fresh = this.quote(quote.asset, quote.gasUnits, quote.quotedAt);
    if (fresh.quoteId !== quote.quoteId || fresh.gasFee !== quote.gasFee || fresh.gasPricePerUnit !== quote.gasPricePerUnit || fresh.oracleRef !== quote.oracleRef) {
      throw new Error("GAS_QUOTE_TAMPERED");
    }
    const key = tupleKey(orderId, quote.quoteId);
    const existing = this.sponsored.get(key);
    if (existing) return { ...existing.quote };
    this.sweepExpired(now);
    const actorId = opts.actorId ?? orderId;
    const holdUntil = opts.holdUntil ?? quote.expiresAt;
    if (!Number.isSafeInteger(holdUntil) || holdUntil < now) throw new Error("INVALID_SPONSOR_HOLD");
    const reserve = this.reserves.get(quote.asset) ?? 0n;
    if (reserve < quote.gasFee) throw new Error("PAYMASTER_RESERVE_INSUFFICIENT");
    const capacity = reserve + this.outstandingOf(quote.asset);
    if (this.maxGasPerOrder !== undefined && quote.gasFee > this.maxGasPerOrder) throw new Error("PAYMASTER_ORDER_CAP_EXCEEDED");
    if (quote.gasFee * 10_000n > capacity * BigInt(this.maxOrderShareBps)) throw new Error("PAYMASTER_ORDER_CAP_EXCEEDED");
    const actor = this.actorOutstandingOf(actorId, quote.asset);
    if (actor.count >= this.maxOutstandingPerActor) throw new Error("PAYMASTER_ACTOR_LIMIT_REACHED");
    if ((actor.amount + quote.gasFee) * 10_000n > capacity * BigInt(this.maxActorShareBps)) throw new Error("PAYMASTER_ACTOR_CAP_EXCEEDED");
    this.reserves.set(quote.asset, reserve - quote.gasFee);
    this.track(quote.asset, actorId, 1, quote.gasFee);
    this.sponsored.set(key, { quote: { ...quote }, orderId, actorId, holdUntil, pinned: false });
    this.heapPush({ at: holdUntil, key });
    return { ...quote };
  }

  /**
   * Keep a sponsorship past `holdUntil` (the order was delivered and will be
   * settled or refunded through capture() / release()).
   */
  pin(orderId: string, quoteId: string): void {
    const s = this.sponsored.get(tupleKey(orderId, quoteId));
    if (!s) throw new Error("PAYMASTER_SPONSOR_NOT_FOUND");
    s.pinned = true;
  }

  /**
   * Release every unpinned sponsorship whose `holdUntil` is before `now`
   * (at most `limit`). Returns the released order ids. Called lazily by
   * sponsor(); operators may also call it periodically.
   */
  sweepExpired(now = this.now(), limit = Number.MAX_SAFE_INTEGER): string[] {
    const released: string[] = [];
    while (this.expiryHeap.length > 0 && this.expiryHeap[0]!.at < now && released.length < limit) {
      const { key } = this.heapPop()!;
      const s = this.sponsored.get(key);
      if (!s || s.pinned || s.holdUntil >= now || this.captured.has(key)) continue;
      this.releaseKey(key, s);
      released.push(s.orderId);
    }
    return released;
  }

  sponsoredQuote(orderId: string, quoteId: string): GasQuote {
    const s = this.sponsored.get(tupleKey(orderId, quoteId));
    if (!s) throw new Error("PAYMASTER_SPONSOR_NOT_FOUND");
    return { ...s.quote };
  }

  /** True while the sponsorship is open (sponsored and not captured / released). */
  isSponsored(orderId: string, quoteId: string): boolean {
    const key = tupleKey(orderId, quoteId);
    return this.sponsored.has(key) && !this.captured.has(key);
  }

  capture(orderId: string, quote: GasQuote, now = this.now()): PaymasterReceipt {
    const key = tupleKey(orderId, quote.quoteId);
    if (this.captured.has(key)) {
      const existing = this.receipts.find((r) => r.orderId === orderId && r.quoteId === quote.quoteId);
      if (!existing) throw new Error("PAYMASTER_RECEIPT_MISSING");
      return { ...existing };
    }
    const s = this.sponsored.get(key);
    if (!s) throw new Error("PAYMASTER_SPONSOR_REQUIRED");
    // The sponsor advanced the fee at quote time; settlement repays that advance from buyer escrow.
    this.reserves.set(quote.asset, (this.reserves.get(quote.asset) ?? 0n) + s.quote.gasFee);
    this.track(s.quote.asset, s.actorId, -1, -s.quote.gasFee);
    // Captured sponsorships keep only the receipt.
    this.sponsored.delete(key);
    const receipt: PaymasterReceipt = { quoteId: quote.quoteId, orderId, asset: quote.asset, gasFee: s.quote.gasFee, capturedAt: now };
    this.captured.add(key);
    this.receipts.push(receipt);
    return { ...receipt };
  }

  /** A failed pre-settlement order releases the sponsor reserve. Idempotent; no-op once captured or swept. */
  release(orderId: string, quote: Pick<GasQuote, "quoteId">): void {
    const key = tupleKey(orderId, quote.quoteId);
    const s = this.sponsored.get(key);
    if (!s || this.captured.has(key)) return;
    this.releaseKey(key, s);
  }

  private releaseKey(key: string, s: Sponsorship): void {
    this.reserves.set(s.quote.asset, (this.reserves.get(s.quote.asset) ?? 0n) + s.quote.gasFee);
    this.track(s.quote.asset, s.actorId, -1, -s.quote.gasFee);
    this.sponsored.delete(key);
  }

  private track(asset: string, actorId: string, dCount: number, dAmount: bigint): void {
    const total = (this.outstanding.get(asset) ?? 0n) + dAmount;
    if (total < 0n) throw new Error("PAYMASTER_ACCOUNTING_UNDERFLOW");
    if (total === 0n) this.outstanding.delete(asset); else this.outstanding.set(asset, total);
    const k = tupleKey(actorId, asset);
    const a = this.actorOutstanding.get(k) ?? { count: 0, amount: 0n };
    const next = { count: a.count + dCount, amount: a.amount + dAmount };
    if (next.count < 0 || next.amount < 0n) throw new Error("PAYMASTER_ACCOUNTING_UNDERFLOW");
    if (next.count === 0) this.actorOutstanding.delete(k); else this.actorOutstanding.set(k, next);
  }

  private heapPush(e: { at: number; key: string }): void {
    const h = this.expiryHeap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.at <= h[i]!.at) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  private heapPop(): { at: number; key: string } | undefined {
    const h = this.expiryHeap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l]!.at < h[m]!.at) m = l;
        if (r < h.length && h[r]!.at < h[m]!.at) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
}
