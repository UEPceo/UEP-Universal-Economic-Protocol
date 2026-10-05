/**
 * uep.service.dispute.v1 — k-of-n arbiter quorum over category HOLDs (v0.5.2).
 * Does not move order escrow itself: swap/relay apply the verdict via DisputeCap.
 * Bond: max(50, 1% of escrow); forfeit 80% respondent / 20% RISK_RESERVE when
 * frivolous on a full loss. Timeout default refunds the buyer (releaseBps 0).
 * Heights (ADR 0002), amounts bigint (ADR 0001).
 */
import { canonicalJson } from "../core/canonical-json.ts";
import type { ActorAuth } from "../marketplace/identity.ts";
import type { CategoryEscrowPort } from "../marketplace/category-escrow.ts";
import { HeightGuard, ReplayGuard } from "./signed.ts";
import type { Disputable, EscrowView } from "./disputable.ts";
import { assertHex32, assertNonNegInt, assertPositiveBigint, mulDivFloor, sha256Hex } from "./relay-crypto.ts";

export interface DisputeConfig {
  minBond: bigint;
  bondBps: number;
  evidenceHeights: number;
  resolutionHeights: number;
  defaultReleaseBps: 0 | 5000;
  forfeitRespondentBps: number;
  maxEvidencePerParty: number;
  maxEvidenceBytes: number;
}

/** evidence 720 (~1 h), resolution 120_960 (~7 d). */
export const DEFAULT_DISPUTE_CONFIG: DisputeConfig = {
  minBond: 50n,
  bondBps: 100,
  evidenceHeights: 720,
  resolutionHeights: 120_960,
  defaultReleaseBps: 0,
  forfeitRespondentBps: 8000,
  maxEvidencePerParty: 8,
  maxEvidenceBytes: 64 * 1024,
};

export interface OpenDisputeBody {
  category: "swap" | "relay";
  orderId: string;
  bondAsset: string;
  bondAmount: bigint;
  nonce: number;
}

export interface EvidenceBody {
  disputeId: string;
  evidenceId: string;
  digest: string;
}

export type VerdictKind = "RELEASE" | "REFUND_BUYER" | "SPLIT";

export interface VerdictBody {
  disputeId: string;
  orderId: string;
  category: "swap" | "relay";
  kind: VerdictKind;
  releaseBps: number;
  frivolous: boolean;
}

export type CaseState = "OPEN" | "RESOLVED" | "TIMED_OUT";

export interface EvidenceItem {
  evidenceId: string;
  by: string;
  digest: string;
  size: number;
  at: number;
}

export interface DisputeCase {
  disputeId: string;
  category: "swap" | "relay";
  orderId: string;
  claimantId: string;
  respondentId: string;
  claimantIsBuyerSide: boolean;
  bondAsset: string;
  bondAmount: bigint;
  openedAt: number;
  evidenceDeadline: number;
  resolutionDeadline: number;
  state: CaseState;
  releaseBps?: number;
  frivolous?: boolean;
  bondForfeited?: boolean;
  evidence: EvidenceItem[];
}

export function disputeIdOf(category: string, orderId: string): string {
  return `dsp_${sha256Hex(canonicalJson(["UEP-DISPUTE-ID-v1", category, orderId])).slice(0, 32)}`;
}

export function verdictKindFor(releaseBps: number): VerdictKind {
  return releaseBps === 10_000 ? "RELEASE" : releaseBps === 0 ? "REFUND_BUYER" : "SPLIT";
}

interface Attached {
  cat: Disputable;
  cap: import("./disputable.ts").DisputeCap;
}

export class DisputeCategory {
  private cases = new Map<string, DisputeCase>();
  private attached = new Map<string, Attached>();
  private adverse = new Map<string, number>();
  private readonly replay = new ReplayGuard();
  private readonly heights = new HeightGuard();
  private readonly arbiters: Set<string>;
  private readonly cfg: DisputeConfig;

  private readonly port: CategoryEscrowPort;
  private readonly quorum: number;

  constructor(port: CategoryEscrowPort, arbiterIds: string[], quorum: number, cfg: Partial<DisputeConfig> = {}) {
    if (port.module !== "dispute") throw new Error("CATEGORY_PORT_MISMATCH");
    this.port = port;
    this.quorum = quorum;
    this.cfg = { ...DEFAULT_DISPUTE_CONFIG, ...cfg };
    this.arbiters = new Set(arbiterIds);
    if (this.arbiters.size !== arbiterIds.length || this.arbiters.size === 0) throw new Error("DISPUTE_ARBITERS");
    for (const id of this.arbiters) if (!this.port.isRegistered(id)) throw new Error("DISPUTE_ARBITER_UNREGISTERED");
    if (!Number.isSafeInteger(quorum) || quorum * 2 <= this.arbiters.size || quorum > this.arbiters.size) {
      throw new Error("DISPUTE_QUORUM");
    }
    if (this.cfg.defaultReleaseBps !== 0 && this.cfg.defaultReleaseBps !== 5000) throw new Error("DISPUTE_DEFAULT");
  }

  attach(cat: Disputable, cap: import("./disputable.ts").DisputeCap): void {
    if (this.attached.has(cat.category)) throw new Error("DISPUTE_ATTACHED");
    this.attached.set(cat.category, { cat, cap });
  }

  open(auth: ActorAuth, body: OpenDisputeBody): DisputeCase {
    const height = this.port.height();
    this.heights.check(height);
    const att = this.attached.get(body.category);
    if (!att) throw new Error("DISPUTE_CATEGORY");
    assertPositiveBigint(body.bondAmount, "bondAmount");
    assertNonNegInt(body.nonce, "nonce");
    body.bondAsset = this.port.assertAsset(body.bondAsset);

    const view = att.cat.escrowView(body.orderId);
    if (!view) throw new Error("DISPUTE_ORDER_UNKNOWN");
    if (!view.open) throw new Error("DISPUTE_ORDER_CLOSED");
    if (view.frozen) throw new Error("DISPUTE_ALREADY_EXISTS");

    const disputeId = disputeIdOf(body.category, body.orderId);
    const claimant = this.port.authenticate(auth, "dispute-open", disputeId, {
      category: body.category,
      orderId: body.orderId,
      bondAsset: body.bondAsset,
      bondAmount: body.bondAmount,
      nonce: body.nonce,
    });
    const buyerSide = view.buyerSide.includes(claimant);
    if (!buyerSide && !view.sellerSide.includes(claimant)) throw new Error("DISPUTE_NOT_PARTY");
    if (this.cases.has(disputeId)) throw new Error("DISPUTE_ALREADY_EXISTS");
    this.replay.check("dispute-open", claimant, body.nonce);

    const escrowSum = view.escrows.filter((e) => e.asset === body.bondAsset).reduce((s, e) => s + e.amount, 0n);
    if (escrowSum === 0n) throw new Error("DISPUTE_BOND_ASSET");
    const proportional = (escrowSum * BigInt(this.cfg.bondBps) + 9_999n) / 10_000n;
    const required = proportional > this.cfg.minBond ? proportional : this.cfg.minBond;
    if (body.bondAmount < required) throw new Error("DISPUTE_BOND_TOO_LOW");

    this.port.openHold(`${disputeId}:bond`, claimant, body.bondAsset, body.bondAmount);
    try {
      att.cat.freeze(att.cap, body.orderId, disputeId);
    } catch (err) {
      this.port.refundHold(`${disputeId}:bond`);
      throw err;
    }
    this.replay.consume("dispute-open", claimant, body.nonce);

    const c: DisputeCase = {
      disputeId,
      category: body.category,
      orderId: body.orderId,
      claimantId: claimant,
      respondentId: buyerSide ? view.sellerId : view.buyerId,
      claimantIsBuyerSide: buyerSide,
      bondAsset: body.bondAsset,
      bondAmount: body.bondAmount,
      openedAt: height,
      evidenceDeadline: height + this.cfg.evidenceHeights,
      resolutionDeadline: height + this.cfg.evidenceHeights + this.cfg.resolutionHeights,
      state: "OPEN",
      evidence: [],
    };
    this.cases.set(disputeId, c);
    return structuredClone(c);
  }

  submitEvidence(auth: ActorAuth, body: EvidenceBody, payload: Buffer): EvidenceItem {
    const height = this.port.height();
    this.heights.check(height);
    const c = this.requireCase(body.disputeId);
    if (c.state !== "OPEN") throw new Error("DISPUTE_CLOSED");
    if (height > c.evidenceDeadline) throw new Error("DISPUTE_EVIDENCE_CLOSED");
    const actor = this.port.authenticate(auth, "dispute-evidence", body.disputeId, {
      disputeId: body.disputeId,
      evidenceId: body.evidenceId,
      digest: body.digest,
    });
    if (actor !== c.claimantId && actor !== c.respondentId) throw new Error("DISPUTE_NOT_PARTY");
    assertHex32(body.digest, "digest");
    if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > this.cfg.maxEvidenceBytes) {
      throw new Error("DISPUTE_EVIDENCE_SIZE");
    }
    if (sha256Hex(payload) !== body.digest) throw new Error("DISPUTE_EVIDENCE_DIGEST");
    if (c.evidence.some((e) => e.evidenceId === body.evidenceId)) throw new Error("DISPUTE_EVIDENCE_DUPLICATE");
    if (c.evidence.filter((e) => e.by === actor).length >= this.cfg.maxEvidencePerParty) {
      throw new Error("DISPUTE_EVIDENCE_LIMIT");
    }
    const item: EvidenceItem = { evidenceId: body.evidenceId, by: actor, digest: body.digest, size: payload.length, at: height };
    c.evidence.push(item);
    return { ...item };
  }

  /**
   * A quorum of distinct arbiters each signs the same verdict via ActorAuth
   * ("dispute-verdict"). Signers must be in the fixed arbiter set and not parties.
   */
  resolve(disputeId: string, verdicts: { auth: ActorAuth; body: VerdictBody }[]): DisputeCase {
    const height = this.port.height();
    this.heights.check(height);
    const c = this.requireCase(disputeId);
    if (c.state !== "OPEN") throw new Error("DISPUTE_CLOSED");
    if (height <= c.evidenceDeadline) throw new Error("DISPUTE_EVIDENCE_OPEN");
    if (height > c.resolutionDeadline) throw new Error("DISPUTE_RESOLUTION_EXPIRED");
    const att = this.attachedFor(c);
    const view = att.cat.escrowView(c.orderId);
    if (!view) throw new Error("DISPUTE_ORDER_UNKNOWN");
    const parties = new Set([...view.buyerSide, ...view.sellerSide]);

    const signers = new Set<string>();
    let reference: string | undefined;
    let verdict: VerdictBody | undefined;
    for (const { auth, body: v } of verdicts) {
      const signer = this.port.authenticate(auth, "dispute-verdict", disputeId, {
        disputeId: v.disputeId,
        orderId: v.orderId,
        category: v.category,
        kind: v.kind,
        releaseBps: v.releaseBps,
        frivolous: v.frivolous,
      });
      if (!this.arbiters.has(signer)) throw new Error("DISPUTE_ARBITER");
      if (parties.has(signer)) throw new Error("DISPUTE_ARBITER_CONFLICT");
      if (v.disputeId !== c.disputeId || v.orderId !== c.orderId || v.category !== c.category) {
        throw new Error("DISPUTE_VERDICT_BINDING");
      }
      if (!Number.isSafeInteger(v.releaseBps) || v.releaseBps < 0 || v.releaseBps > 10_000) {
        throw new Error("DISPUTE_VERDICT_INVALID");
      }
      if (v.kind !== verdictKindFor(v.releaseBps) || typeof v.frivolous !== "boolean") {
        throw new Error("DISPUTE_VERDICT_INVALID");
      }
      const canon = canonicalJson(v);
      if (reference !== undefined && canon !== reference) throw new Error("DISPUTE_VERDICT_MISMATCH");
      reference = canon;
      verdict = v;
      signers.add(signer);
    }
    if (!verdict || signers.size < this.quorum) throw new Error("DISPUTE_QUORUM_NOT_MET");

    const totalLoss = c.claimantIsBuyerSide ? verdict.releaseBps === 10_000 : verdict.releaseBps === 0;
    if (verdict.frivolous && !totalLoss) throw new Error("DISPUTE_VERDICT_INVALID");

    this.finish(c, att, verdict.releaseBps, verdict.frivolous);
    c.state = "RESOLVED";
    return structuredClone(c);
  }

  timeout(disputeId: string): DisputeCase {
    const height = this.port.height();
    this.heights.check(height);
    const c = this.requireCase(disputeId);
    if (c.state !== "OPEN") throw new Error("DISPUTE_CLOSED");
    if (height <= c.resolutionDeadline) throw new Error("DISPUTE_NOT_TIMED_OUT");
    this.finish(c, this.attachedFor(c), this.cfg.defaultReleaseBps, false);
    c.state = "TIMED_OUT";
    return structuredClone(c);
  }

  get(disputeId: string): DisputeCase | undefined {
    const c = this.cases.get(disputeId);
    return c ? structuredClone(c) : undefined;
  }

  adverseCount(id: string): number {
    return this.adverse.get(id) ?? 0;
  }

  private requireCase(id: string): DisputeCase {
    const c = this.cases.get(id);
    if (!c) throw new Error("DISPUTE_UNKNOWN");
    return c;
  }

  private attachedFor(c: DisputeCase): Attached {
    const a = this.attached.get(c.category);
    if (!a) throw new Error("DISPUTE_CATEGORY");
    return a;
  }

  private finish(c: DisputeCase, att: Attached, releaseBps: number, frivolous: boolean): void {
    const holdId = `${c.disputeId}:bond`;
    if (frivolous) {
      const toRespondent = mulDivFloor(c.bondAmount, this.cfg.forfeitRespondentBps, 10_000);
      const toTreasury = c.bondAmount - toRespondent;
      this.port.releaseHold(
        holdId,
        [{ to: c.respondentId, amount: toRespondent }].filter((p) => p.amount > 0n),
        toTreasury > 0n ? { refId: `${c.disputeId}:forfeit`, amount: toTreasury } : undefined,
      );
    } else {
      this.port.refundHold(holdId);
    }
    att.cat.apply(att.cap, c.orderId, c.disputeId, releaseBps);
    c.releaseBps = releaseBps;
    c.frivolous = frivolous;
    c.bondForfeited = frivolous;
    if (frivolous) this.adverse.set(c.claimantId, (this.adverse.get(c.claimantId) ?? 0) + 1);
  }
}

export type { EscrowView };
