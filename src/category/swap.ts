/**
 * uep.service.swap.v1 — bilateral cross-asset settlement over Marketplace HOLDs
 * (v0.5.2). Hashlock is domain-separated SHA-256 (not Poseidon).
 *
 * Auth: Marketplace ActorAuth (registered identities). Funds: CategoryEscrowPort
 * (Marketplace balances + settlement engine). Heights from the port (ADR 0002).
 * Amounts bigint (ADR 0001). Protocol fee is NOT charged on business-layer
 * releases; marketplace fee is charged on the fromAsset leg the maker receives.
 */
import { canonicalJson } from "../core/canonical-json.ts";
import type { ActorAuth } from "../marketplace/identity.ts";
import type { CategoryEscrowPort } from "../marketplace/category-escrow.ts";
import { HeightGuard, ReplayGuard } from "./signed.ts";
import type { IndexWriter, SettlementIndex } from "./settlement-index.ts";
import { newDisputeCapRegistry, type DisputeCap, type Disputable, type EscrowView } from "./disputable.ts";
import { assertHex32, assertNonNegInt, assertPositiveBigint, mulDivFloor, sha256Hex, swapHashlock } from "./relay-crypto.ts";

export type SwapState = "DUAL_HOLD_LOCKED" | "ATOMICALLY_SETTLED" | "EXPIRED_REFUNDED" | "DISPUTE_RESOLVED";

/** Max lifetime: 7 days = 120_960 heights at the 5 s reference block. */
export const MAX_SWAP_LIFETIME_HEIGHTS = 120_960;
/** Refuse legs too small to leave a net after the marketplace fee. */
export const MIN_LEG_AMOUNT = 2n;

export interface SwapIntentBody {
  version: 1;
  category: "uep.service.swap.v1";
  networkId: string;
  buyerId: string;
  marketMakerId: string;
  fromAsset: string;
  fromAmount: bigint;
  toAsset: string;
  toAmount: bigint;
  hashlock: string;
  /** Absolute height deadline (ADR 0002). */
  deadline: number;
  orderNonce: number;
}

export interface SwapAcceptBody {
  intentId: string;
}

export interface OpenSwap {
  intentId: string;
  intent: SwapIntentBody;
  state: SwapState;
  openedAt: number;
  settledAt?: number;
  revealedPreimage?: string;
  frozenBy?: string;
}

export function swapIntentId(intent: SwapIntentBody): string {
  return `swp_${sha256Hex(canonicalJson(["UEP-SWAP-INTENTID-v1", intent])).slice(0, 32)}`;
}

function detailsOf(intent: SwapIntentBody): Record<string, unknown> {
  return {
    version: intent.version,
    category: intent.category,
    networkId: intent.networkId,
    buyerId: intent.buyerId,
    marketMakerId: intent.marketMakerId,
    fromAsset: intent.fromAsset,
    fromAmount: intent.fromAmount,
    toAsset: intent.toAsset,
    toAmount: intent.toAmount,
    hashlock: intent.hashlock,
    deadline: intent.deadline,
    orderNonce: intent.orderNonce,
  };
}

export class SwapCategory implements Disputable {
  readonly category = "swap" as const;
  private orders = new Map<string, OpenSwap>();
  private readonly replay = new ReplayGuard();
  private readonly heights = new HeightGuard();
  private readonly caps = newDisputeCapRegistry();
  private readonly writeIndex: IndexWriter;
  private readonly port: CategoryEscrowPort;
  private readonly networkId: string;

  constructor(port: CategoryEscrowPort, index: SettlementIndex, networkId = "uep-testnet") {
    if (port.module !== "swap") throw new Error("CATEGORY_PORT_MISMATCH");
    this.port = port;
    this.networkId = networkId;
    this.writeIndex = index.issueWriter("swap");
  }

  open(intentAuth: ActorAuth, intent: SwapIntentBody, acceptAuth: ActorAuth, accept: SwapAcceptBody): OpenSwap {
    const height = this.port.height();
    this.heights.check(height);
    this.validateIntent(intent, height);
    const intentId = swapIntentId(intent);

    const buyer = this.port.authenticate(intentAuth, "swap-intent", intentId, detailsOf(intent));
    if (buyer !== intent.buyerId) throw new Error("SWAP_BAD_SIGNATURE");
    const maker = this.port.authenticate(acceptAuth, "swap-accept", intentId, { intentId: accept.intentId });
    if (maker !== intent.marketMakerId) throw new Error("SWAP_BAD_SIGNATURE");
    if (accept.intentId !== intentId) throw new Error("SWAP_INTENT_MISMATCH");

    if (this.orders.has(intentId)) throw new Error("SWAP_NONCE_REPLAY");
    this.replay.check("swap-nonce", intent.buyerId, intent.orderNonce);

    this.port.assertCanOpen([
      { accountId: intent.buyerId, asset: intent.fromAsset, amount: intent.fromAmount },
      { accountId: intent.marketMakerId, asset: intent.toAsset, amount: intent.toAmount },
    ]);
    try {
      this.port.openHold(`${intentId}:buyer`, intent.buyerId, intent.fromAsset, intent.fromAmount);
      this.port.openHold(`${intentId}:maker`, intent.marketMakerId, intent.toAsset, intent.toAmount);
    } catch (err) {
      try { this.port.refundHold(`${intentId}:buyer`); } catch { /* first open may have failed */ }
      throw err;
    }
    this.replay.consume("swap-nonce", intent.buyerId, intent.orderNonce);
    const order: OpenSwap = { intentId, intent: { ...intent }, state: "DUAL_HOLD_LOCKED", openedAt: height };
    this.orders.set(intentId, order);
    return structuredClone(order);
  }

  settle(intentId: string, preimage: string): OpenSwap {
    const height = this.port.height();
    this.heights.check(height);
    const order = this.mustGet(intentId);
    if (order.state !== "DUAL_HOLD_LOCKED") throw new Error("SWAP_ALREADY_SETTLED");
    if (order.frozenBy) throw new Error("SWAP_FROZEN");
    if (height > order.intent.deadline) throw new Error("SWAP_INTENT_EXPIRED");
    const computed = swapHashlock(preimage, order.intent.orderNonce, order.intent.networkId);
    if (computed !== order.intent.hashlock) throw new Error("SWAP_HASHLOCK_MISMATCH");

    this.distribute(order, 10_000, height);
    order.state = "ATOMICALLY_SETTLED";
    order.settledAt = height;
    order.revealedPreimage = preimage;
    return structuredClone(order);
  }

  expire(intentId: string): OpenSwap {
    const height = this.port.height();
    this.heights.check(height);
    const order = this.mustGet(intentId);
    if (order.state !== "DUAL_HOLD_LOCKED") throw new Error("SWAP_ALREADY_SETTLED");
    if (order.frozenBy) throw new Error("SWAP_FROZEN");
    if (height <= order.intent.deadline) throw new Error("SWAP_NOT_EXPIRED");
    this.port.refundHold(`${intentId}:buyer`);
    this.port.refundHold(`${intentId}:maker`);
    order.state = "EXPIRED_REFUNDED";
    return structuredClone(order);
  }

  get(intentId: string): OpenSwap | undefined {
    const o = this.orders.get(intentId);
    return o ? structuredClone(o) : undefined;
  }

  issueDisputeCap(): DisputeCap {
    return this.caps.issue();
  }

  escrowView(orderId: string): EscrowView | undefined {
    const o = this.orders.get(orderId);
    if (!o) return undefined;
    const i = o.intent;
    return {
      orderId,
      category: "swap",
      buyerId: i.buyerId,
      sellerId: i.marketMakerId,
      buyerSide: [i.buyerId],
      sellerSide: [i.marketMakerId],
      escrows: [
        { asset: i.fromAsset, amount: i.fromAmount },
        { asset: i.toAsset, amount: i.toAmount },
      ],
      open: o.state === "DUAL_HOLD_LOCKED",
      frozen: o.frozenBy !== undefined,
    };
  }

  freeze(cap: DisputeCap, orderId: string, caseId: string): void {
    this.caps.check(cap);
    const o = this.mustGet(orderId);
    if (o.state !== "DUAL_HOLD_LOCKED") throw new Error("SWAP_ORDER_STATE");
    if (o.frozenBy) throw new Error("SWAP_FROZEN");
    o.frozenBy = caseId;
  }

  unfreeze(cap: DisputeCap, orderId: string, caseId: string): void {
    this.caps.check(cap);
    const o = this.mustGet(orderId);
    if (o.frozenBy !== caseId) throw new Error("SWAP_FREEZE_OWNER");
    o.frozenBy = undefined;
  }

  apply(cap: DisputeCap, orderId: string, caseId: string, releaseBps: number): void {
    this.caps.check(cap);
    const height = this.port.height();
    const o = this.mustGet(orderId);
    if (o.state !== "DUAL_HOLD_LOCKED" || o.frozenBy !== caseId) throw new Error("SWAP_ORDER_STATE");
    if (!Number.isSafeInteger(releaseBps) || releaseBps < 0 || releaseBps > 10_000) throw new Error("SWAP_BPS");
    this.distribute(o, releaseBps, height);
    o.state = "DISPUTE_RESOLVED";
    o.frozenBy = undefined;
    o.settledAt = height;
  }

  private mustGet(intentId: string): OpenSwap {
    const order = this.orders.get(intentId);
    if (!order) throw new Error("SWAP_ORDER_STATE");
    return order;
  }

  private validateIntent(i: SwapIntentBody, height: number): void {
    if (i.version !== 1) throw new Error("SWAP_VERSION");
    if (i.networkId !== this.networkId) throw new Error("SWAP_NETWORK");
    if (i.category !== "uep.service.swap.v1") throw new Error("SWAP_CATEGORY");
    if (!this.port.isRegistered(i.buyerId) || !this.port.isRegistered(i.marketMakerId)) throw new Error("IDENTITY_NOT_REGISTERED");
    if (i.buyerId === i.marketMakerId) throw new Error("SWAP_PARTY");
    i.fromAsset = this.port.assertAsset(i.fromAsset);
    i.toAsset = this.port.assertAsset(i.toAsset);
    if (i.fromAsset === i.toAsset) throw new Error("SWAP_ASSET_MISMATCH");
    assertPositiveBigint(i.fromAmount, "fromAmount");
    assertPositiveBigint(i.toAmount, "toAmount");
    assertHex32(i.hashlock, "hashlock");
    assertNonNegInt(i.orderNonce, "orderNonce");
    assertNonNegInt(i.deadline, "deadline");
    if (height > i.deadline) throw new Error("SWAP_INTENT_EXPIRED");
    if (i.deadline - height > MAX_SWAP_LIFETIME_HEIGHTS) throw new Error("SWAP_DEADLINE_TOO_FAR");
    if (i.fromAmount < MIN_LEG_AMOUNT || this.port.quoteFee(i.fromAmount, i.fromAsset) >= i.fromAmount) {
      throw new Error("SWAP_AMOUNT_TOO_SMALL");
    }
  }

  /**
   * Pay `releaseBps` of each leg. fromAsset → maker via settlement engine (fee on
   * released part); toAsset → buyer in full for the released part (no fee).
   * Remainder returns to the locker.
   */
  private distribute(order: OpenSwap, releaseBps: number, height: number): void {
    const i = order.intent;
    const id = order.intentId;
    const rFrom = mulDivFloor(i.fromAmount, releaseBps, 10_000);
    const rTo = mulDivFloor(i.toAmount, releaseBps, 10_000);

    const receipt = this.port.settleHold(`${id}:buyer`, i.marketMakerId, rFrom, id);
    if (receipt.marketplaceFee > 0n) {
      this.writeIndex({
        orderId: id,
        category: "swap",
        providerId: i.marketMakerId,
        asset: i.fromAsset,
        feeCollected: receipt.marketplaceFee,
        receiptHash: receipt.receiptHash,
        settledAt: height,
      });
    }

    if (rTo === 0n) {
      this.port.refundHold(`${id}:maker`);
    } else if (rTo === i.toAmount) {
      this.port.releaseHold(`${id}:maker`, [{ to: i.buyerId, amount: i.toAmount }]);
    } else {
      this.port.releaseHold(`${id}:maker`, [
        { to: i.buyerId, amount: rTo },
        { to: i.marketMakerId, amount: i.toAmount - rTo },
      ]);
    }
  }
}

export { swapHashlock };
