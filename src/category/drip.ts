/**
 * Drip subsidy controller (v0.5.2). Claims only against SettlementIndex rows
 * written by swap/relay. At most perOrderBps (default 5000 = 50 %) of that
 * order's marketplace fee, once per order. Paid through SubsidyPort (treasury
 * drip budget). Heights (ADR 0002), amounts bigint (ADR 0001).
 */
import { canonicalJson } from "../core/canonical-json.ts";
import type { ActorAuth } from "../marketplace/identity.ts";
import type { SubsidyPort } from "../marketplace/category-escrow.ts";
import { HeightGuard, ReplayGuard } from "./signed.ts";
import type { SettlementIndex } from "./settlement-index.ts";
import { assertHex32, assertNonNegInt, assertPositiveBigint, mulDivFloor } from "./relay-crypto.ts";

export interface DripConfig {
  maxSingle: bigint;
  cooldownHeights: number;
  hourlyCapBps: number;
  windowHeights: number;
  perOrderBps: number;
  validityHeights: number;
}

/** cooldown 6 (~30 s), window 720 (~1 h), validity 17_280 (~1 d). */
export const DEFAULT_DRIP_CONFIG: DripConfig = {
  maxSingle: 50n,
  cooldownHeights: 6,
  hourlyCapBps: 50,
  windowHeights: 720,
  perOrderBps: 5000,
  validityHeights: 17_280,
};

export interface DripClaimBody {
  nodeId: string;
  asset: string;
  amount: bigint;
  orderId: string;
  receiptHash: string;
  nonce: number;
}

export class DripController {
  private spentOrders = new Set<string>();
  private lastClaim = new Map<string, number>();
  private windows = new Map<string, { start: number; spent: bigint }>();
  private readonly replay = new ReplayGuard();
  private readonly heights = new HeightGuard();
  private readonly cfg: DripConfig;

  private readonly port: SubsidyPort;
  private readonly index: SettlementIndex;

  constructor(port: SubsidyPort, index: SettlementIndex, cfg: Partial<DripConfig> = {}) {
    this.port = port;
    this.index = index;
    this.cfg = { ...DEFAULT_DRIP_CONFIG, ...cfg };
  }

  claim(auth: ActorAuth, body: DripClaimBody): bigint {
    const height = this.port.height();
    this.heights.check(height);
    assertPositiveBigint(body.amount, "amount");
    assertHex32(body.receiptHash, "receipt");
    assertNonNegInt(body.nonce, "nonce");
    if (body.amount > this.cfg.maxSingle) throw new Error("DRIP_AMOUNT_EXCEEDS_SINGLE");

    const nodeId = this.port.authenticate(auth, "drip-claim", body.orderId, {
      nodeId: body.nodeId,
      asset: body.asset,
      amount: body.amount,
      orderId: body.orderId,
      receiptHash: body.receiptHash,
      nonce: body.nonce,
    });
    if (nodeId !== body.nodeId) throw new Error("DRIP_SIGNER");
    if (!this.port.isRegistered(nodeId)) throw new Error("IDENTITY_NOT_REGISTERED");
    this.replay.check("drip", nodeId, body.nonce);

    const work = this.index.get(body.orderId);
    if (!work) throw new Error("DRIP_WORK_UNVERIFIED");
    if (work.providerId !== nodeId) throw new Error("DRIP_NOT_PROVIDER");
    if (work.asset !== body.asset || work.receiptHash !== body.receiptHash) throw new Error("DRIP_WORK_MISMATCH");
    if (height < work.settledAt || height - work.settledAt > this.cfg.validityHeights) throw new Error("DRIP_RECEIPT_EXPIRED");
    if (this.spentOrders.has(body.orderId)) throw new Error("DRIP_ALREADY_CLAIMED");

    const entitlement = work.feeCollected === 0n
      ? 0n
      : (() => {
          const share = mulDivFloor(work.feeCollected, this.cfg.perOrderBps, 10_000);
          return share < this.cfg.maxSingle ? share : this.cfg.maxSingle;
        })();
    if (entitlement < 1n) throw new Error("DRIP_NO_ENTITLEMENT");
    if (body.amount > entitlement) throw new Error("DRIP_AMOUNT_EXCEEDS_ENTITLEMENT");

    const cdKey = canonicalJson([nodeId, body.asset]);
    const last = this.lastClaim.get(cdKey);
    if (last !== undefined && height - last < this.cfg.cooldownHeights) throw new Error("DRIP_COOLDOWN");

    let win = this.windows.get(body.asset);
    if (!win || height - win.start >= this.cfg.windowHeights) win = { start: height, spent: 0n };
    const base = this.port.budgetOf(body.asset) + win.spent;
    const hourlyCap = (() => {
      const cap = mulDivFloor(base, this.cfg.hourlyCapBps, 10_000);
      return cap > this.cfg.maxSingle ? cap : this.cfg.maxSingle;
    })();
    if (win.spent + body.amount > hourlyCap) throw new Error("DRIP_HOURLY_CAP");

    this.port.pay(body.orderId, nodeId, body.asset, body.amount);

    win.spent += body.amount;
    this.windows.set(body.asset, win);
    this.lastClaim.set(cdKey, height);
    this.spentOrders.add(body.orderId);
    this.replay.consume("drip", nodeId, body.nonce);
    return body.amount;
  }
}
