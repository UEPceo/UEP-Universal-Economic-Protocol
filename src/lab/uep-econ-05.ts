/**
 * UEP-ECON-05 — Canonical economic tip + obligation↔hold machine (lab→protocol)
 *
 * Economic tip commitment is the consensus-facing digest of the full economic
 * surface (balances root, nullifiers, height, applied txs, nonces, holds, obligations).
 *
 * Obligation lifecycle (deterministic, height-based timeouts):
 *   OPEN → DELIVERED → SETTLED
 *   OPEN → CANCELLED | EXPIRED
 *   DELIVERED → DISPUTED → (CLIENT_WINS | PROVIDER_WINS | SPLIT)  [SPLIT deferred]
 *
 * NO native token. NO SpendCircuit change.
 */

import { createHash } from "node:crypto";
import { setCommitment, canonicalId, canonicalFields } from "./uep-canonical-encode.ts";
import type { HoldRecord } from "./uep-econ-04.ts";
import {
  buildHoldOpenTx,
  type ProtocolBatchTx,
  DEFAULT_HOLD_TTL_HEIGHTS,
  LAB_ECON_NETWORK,
  LAB_ECON_DOMAIN,
} from "./uep-econ-04.ts";

export const ECON_05_VERSION = "ECON-05.2.2";
/** Blocks after DELIVERED during which client may dispute. */
export const DEFAULT_INSPECTION_BLOCKS = 5;

/** Prefix for tip digests (distinct from A1 hash composition). */
export const ECON_TIP_DOMAIN = "UEP-ECON-TIP-05.2.6";

export type ObligationStatusE05 =
  | "OPEN"
  | "DELIVERED"
  | "SETTLED"
  | "CANCELLED"
  | "DISPUTED"
  | "EXPIRED"
  | "CLIENT_WINS"
  | "PROVIDER_WINS";

export type ObligationRecord = {
  obligationId: string;
  offerId: string;
  clientId: string;
  providerId: string;
  price: bigint;
  holdId: string;
  expectedResultDigest: string;
  status: ObligationStatusE05;
  createdHeight: number;
  /** Height after which OPEN may expire → RELEASE hold */
  deliverByHeight: number;
  /** Height after which DELIVERED may auto-settle or expire policy */
  settleByHeight: number;
  /** Height when marked DELIVERED (inspection window start) */
  deliveredHeight?: number;
  /** Client-only settle allowed immediately; provider claim after this height */
  inspectionUntilHeight?: number;
  disputedHeight?: number;
  deliveryDigest?: string;
  settlementTxId?: string;
};

export function obligationCommitment(o: ObligationRecord): string {
  return [
    o.obligationId,
    o.offerId,
    o.clientId,
    o.providerId,
    o.price.toString(),
    o.holdId,
    o.expectedResultDigest,
    o.status,
    String(o.createdHeight),
    String(o.deliverByHeight),
    String(o.settleByHeight),
    String(o.deliveredHeight ?? ""),
    String(o.inspectionUntilHeight ?? ""),
    String(o.disputedHeight ?? ""),
    o.deliveryDigest ?? "",
    o.settlementTxId ?? "",
  ].join("|");
}

export function obligationsCommitment(
  obs: Map<string, ObligationRecord>,
): string {
  const parts: string[] = [];
  for (const id of [...obs.keys()].sort()) {
    parts.push(obligationCommitment(obs.get(id)!));
  }
  return setCommitment(parts);
}

export type EconomicTipParts = {
  stateRoot: string;
  nullifierRoot: string;
  height: number;
  appliedTxCommitment: string;
  authNonceCommitment: string;
  holdsCommitment: string;
  obligationsCommitment: string;
  treasury: string;
  /** Structural/Poseidon sidecar roots; empty on Local map state. */
  holdsSmtRoot?: string;
  obligationsSmtRoot?: string;
};

export function computeEconomicTip(parts: EconomicTipParts): string {
  // P2: length-prefixed fields — no insertion-order or join("|") ambiguity
  return createHash("sha256")
    .update(
      canonicalFields([
        ECON_TIP_DOMAIN,
        parts.stateRoot,
        parts.nullifierRoot,
        String(parts.height),
        parts.appliedTxCommitment,
        parts.authNonceCommitment,
        parts.holdsCommitment,
        parts.obligationsCommitment,
        parts.treasury,
        parts.holdsSmtRoot ?? "",
        parts.obligationsSmtRoot ?? "",
      ]),
    )
    .digest("hex");
}

export function makeObligationIdE05(
  offerId: string,
  clientId: string,
  nonce: string,
): string {
  return canonicalId(["OBL05", offerId, clientId, nonce], 24);
}

/** Allowed transitions (actor checked by callers). */
export const OBLIGATION_TRANSITIONS: Record<
  ObligationStatusE05,
  ObligationStatusE05[]
> = {
  OPEN: ["DELIVERED", "CANCELLED", "EXPIRED"],
  DELIVERED: ["SETTLED", "DISPUTED", "EXPIRED"],
  DISPUTED: ["CLIENT_WINS", "PROVIDER_WINS"],
  SETTLED: [],
  CANCELLED: [],
  EXPIRED: [],
  CLIENT_WINS: [],
  PROVIDER_WINS: [],
};

export function canTransition(
  from: ObligationStatusE05,
  to: ObligationStatusE05,
): boolean {
  return (OBLIGATION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Create OPEN obligation + hold_open fields for a single atomic batch pair.
 * Caller applies [holdTx] then registers obligation, or applies both via helper.
 */
export function buildAcceptWithHold(input: {
  offerId: string;
  clientId: string;
  providerId: string;
  price: bigint;
  expectedResultDigest: string;
  clientNonce: string;
  holdTxId: string;
  currentHeight: number;
  deliverWithinHeights?: number;
  settleWithinHeights?: number;
}): { obligation: ObligationRecord; holdTx: ProtocolBatchTx } {
  const obligationId = makeObligationIdE05(
    input.offerId,
    input.clientId,
    input.clientNonce,
  );
  const holdTx = buildHoldOpenTx({
    txId: input.holdTxId,
    clientId: input.clientId,
    providerId: input.providerId,
    obligationId,
    holdNonce: input.clientNonce,
    price: input.price,
  });
  const deliverBy =
    input.currentHeight + (input.deliverWithinHeights ?? DEFAULT_HOLD_TTL_HEIGHTS);
  const settleBy =
    input.currentHeight + (input.settleWithinHeights ?? DEFAULT_HOLD_TTL_HEIGHTS * 2);
  const obligation: ObligationRecord = {
    obligationId,
    offerId: input.offerId,
    clientId: input.clientId,
    providerId: input.providerId,
    price: input.price,
    holdId: holdTx.holdId!,
    expectedResultDigest: input.expectedResultDigest,
    status: "OPEN",
    createdHeight: input.currentHeight,
    deliverByHeight: deliverBy,
    settleByHeight: settleBy,
  };
  return { obligation, holdTx };
}

export function markDelivered(
  obl: ObligationRecord,
  deliveryDigest: string,
  atHeight: number,
  inspectionBlocks: number = DEFAULT_INSPECTION_BLOCKS,
): { ok: true } | { ok: false; reason: string } {
  if (obl.status !== "OPEN") return { ok: false, reason: `BAD_STATUS:${obl.status}` };
  if (deliveryDigest !== obl.expectedResultDigest) {
    obl.status = "DISPUTED";
    obl.disputedHeight = atHeight;
    return { ok: false, reason: "DIGEST_MISMATCH_DISPUTED" };
  }
  obl.status = "DELIVERED";
  obl.deliveryDigest = deliveryDigest;
  obl.deliveredHeight = atHeight;
  obl.inspectionUntilHeight = atHeight + inspectionBlocks;
  return { ok: true };
}

/** Client opens dispute while DELIVERED and within inspection window (or anytime before settle). */
export function openDispute(
  obl: ObligationRecord,
  atHeight: number,
): { ok: true } | { ok: false; reason: string } {
  if (obl.status !== "DELIVERED") {
    return { ok: false, reason: `BAD_STATUS:${obl.status}` };
  }
  // Allow dispute until settled; prefer within inspection window
  if (
    obl.inspectionUntilHeight !== undefined &&
    atHeight > obl.inspectionUntilHeight
  ) {
    return { ok: false, reason: "INSPECTION_WINDOW_CLOSED" };
  }
  if (!canTransition(obl.status, "DISPUTED")) {
    return { ok: false, reason: "BAD_TRANSITION" };
  }
  obl.status = "DISPUTED";
  obl.disputedHeight = atHeight;
  return { ok: true };
}

export function buildHoldResolveTx(input: {
  txId: string;
  clientId: string;
  providerId?: string;
  holdId: string;
  obligationId: string;
  outcome: "CLIENT_WINS" | "PROVIDER_WINS";
}): import("./uep-econ-04.ts").ProtocolBatchTx {
  const from =
    input.outcome === "CLIENT_WINS"
      ? (input.providerId ?? input.clientId)
      : input.clientId;
  return {
    id: input.txId,
    from,
    to: input.clientId,
    amount: 0n,
    kind: "hold_resolve",
    networkId: LAB_ECON_NETWORK,
    domainId: LAB_ECON_DOMAIN,
    holdId: input.holdId,
    obligationId: input.obligationId,
    resolveOutcome: input.outcome,
  };
}
