/**
 * UEP-ECON-04.0 — On-chain hold / escrow (consensus economic state)
 *
 * available(C) = balance(C) − held(C)
 * held is part of economic state + holdsCommitment in canonicalStateCommitment (SMT path).
 *
 * Protocol ops as BatchTx.kind:
 *   hold_open    — reserve price+fee without moving balance
 *   hold_release — free reservation (cancel OPEN)
 *   hold_consume — pay provider + fee and mark CONSUMED (atomic with transfer)
 *   transfer     — default; fails if amount+fee > available
 *
 * EscrowBook (ECON-03) remains lab mirror; ECON-04 is source of truth on-chain.
 */

import type { BatchTx } from "./uep35-batch-lab.ts";
import { creatorFee, requiredSenderDebit } from "../core/fee.ts";
import { canonicalId, setCommitment } from "./uep-canonical-encode.ts";

export const ECON_04_VERSION = "ECON-04.1";
/** refuse zero-value holds (DoS / state bloat). */
export const MIN_HOLD_PRICE = 1n;
export const LAB_ECON_NETWORK = "uep-lab";
export const LAB_ECON_DOMAIN = 0;
/** If protocol fee floors to 0, still lock 1 unit (anti zero-fee spam). */
export const MIN_OPEN_FEE = 1n;
export const TOMBSTONE_MIN_AGE_HEIGHTS = 64;

export type HoldStatus = "HELD" | "RELEASED" | "CONSUMED" | "EXPIRED";

export type HoldRecord = {
  holdId: string;
  obligationId: string;
  clientId: string;
  providerId: string;
  price: bigint;
  feeLocked: bigint;
  /** price + feeLocked while HELD */
  locked: bigint;
  status: HoldStatus;
  createdHeight: number;
};

export type TxKind = "transfer" | "hold_open" | "hold_release" | "hold_consume" | "hold_expire" | "hold_resolve";

export type ProtocolBatchTx = BatchTx & {
  kind?: TxKind;
  /** Required for hold_* */
  holdId?: string;
  obligationId?: string;
  providerId?: string;
  /** Principal (price) for hold_open / hold_consume; amount may equal locked or price */
  price?: bigint;
  /** hold_resolve: CLIENT_WINS | PROVIDER_WINS */
  resolveOutcome?: "CLIENT_WINS" | "PROVIDER_WINS";
};

export function makeHoldId(
  obligationId: string,
  clientId: string,
  nonce: string,
): string {
  return canonicalId(["HOLD", obligationId, clientId, nonce], 24);
}

export function holdRecordCommitment(h: HoldRecord): string {
  return [
    h.holdId,
    h.obligationId,
    h.clientId,
    h.providerId,
    h.price.toString(),
    h.feeLocked.toString(),
    h.locked.toString(),
    h.status,
    String(h.createdHeight),
  ].join("|");
}

export function holdsCommitment(holds: Map<string, HoldRecord>): string {
  const parts: string[] = [];
  for (const id of [...holds.keys()].sort()) {
    const h = holds.get(id)!;
    if (h.status !== "HELD") continue; // tip commits active collateral only
    parts.push(holdRecordCommitment(h));
  }
  return setCommitment(parts);
}

export function pruneTerminatedHolds(
  holds: Map<string, HoldRecord>,
  retiredIds: Set<string>,
  currentHeight: number,
  minAgeHeights: number,
): number {
  let n = 0;
  for (const [id, h] of [...holds.entries()]) {
    if (h.status === "HELD") continue;
    if (currentHeight - h.createdHeight < minAgeHeights) continue;
    retiredIds.add(id);
    holds.delete(id);
    n++;
  }
  return n;
}

export function totalHeldFor(
  holds: Map<string, HoldRecord>,
  clientId: string,
): bigint {
  let s = 0n;
  for (const h of holds.values()) {
    if (h.clientId === clientId && h.status === "HELD") s += h.locked;
  }
  return s;
}

export function buildHoldOpenTx(input: {
  txId: string;
  clientId: string;
  providerId: string;
  obligationId: string;
  holdNonce: string;
  price: bigint;
  auth?: BatchTx["auth"];
}): ProtocolBatchTx {
  const feeLocked = creatorFee(input.price);
  const locked = requiredSenderDebit(input.price);
  const holdId = makeHoldId(input.obligationId, input.clientId, input.holdNonce);
  return {
    id: input.txId,
    from: input.clientId,
    to: input.providerId,
    amount: locked,
    kind: "hold_open",
    networkId: LAB_ECON_NETWORK,
    domainId: LAB_ECON_DOMAIN,
    holdId,
    obligationId: input.obligationId,
    providerId: input.providerId,
    price: input.price,
    auth: input.auth,
  };
}

export function buildHoldReleaseTx(input: {
  txId: string;
  clientId: string;
  holdId: string;
  auth?: BatchTx["auth"];
}): ProtocolBatchTx {
  return {
    id: input.txId,
    from: input.clientId,
    to: input.clientId,
    amount: 0n,
    kind: "hold_release",
    networkId: LAB_ECON_NETWORK,
    domainId: LAB_ECON_DOMAIN,
    holdId: input.holdId,
    auth: input.auth,
  };
}

export function buildHoldConsumeTx(input: {
  txId: string;
  clientId: string;
  providerId: string;
  holdId: string;
  price: bigint;
  auth?: BatchTx["auth"];
}): ProtocolBatchTx {
  return {
    id: input.txId,
    from: input.clientId,
    to: input.providerId,
    amount: input.price,
    kind: "hold_consume",
    networkId: LAB_ECON_NETWORK,
    domainId: LAB_ECON_DOMAIN,
    holdId: input.holdId,
    providerId: input.providerId,
    price: input.price,
    auth: input.auth,
  };
}

/** Provider-initiated settle (only valid after inspectionUntilHeight). */
export function buildHoldConsumeAsProviderTx(input: {
  txId: string;
  clientId: string;
  providerId: string;
  holdId: string;
  price: bigint;
  obligationId?: string;
  auth?: BatchTx["auth"];
}): ProtocolBatchTx {
  return {
    id: input.txId,
    from: input.providerId,
    to: input.providerId,
    amount: input.price,
    kind: "hold_consume",
    networkId: LAB_ECON_NETWORK,
    domainId: LAB_ECON_DOMAIN,
    holdId: input.holdId,
    obligationId: input.obligationId,
    providerId: input.providerId,
    price: input.price,
    auth: input.auth,
  };
}


/** Default heights after creation if obligation has no deliverByHeight. */
export const DEFAULT_HOLD_TTL_HEIGHTS = 64;
/** After DISPUTED, capital cannot lock forever. */
export const MAX_DISPUTE_HEIGHTS = 64;

export function disputeClockStart(
  obl: { disputedHeight?: number; deliveredHeight?: number },
  holdCreatedHeight: number,
): number {
  return obl.disputedHeight ?? obl.deliveredHeight ?? holdCreatedHeight;
}

/**
 * Deterministic expiry: HELD past deadline → EXPIRED (funds available again).
 * OPEN obligation past deliverByHeight → EXPIRED.
 * Does not move balances (hold never left the client balance).
 */
/**
 * Statuses that freeze automatic hold expiry.
 * OPEN may expire; DISPUTED/DELIVERED must not auto-refund the client.
 */
export const EXPIRY_FROZEN_OBLIGATION = new Set([
  "DISPUTED",
  "DELIVERED",
  "SETTLED",
  "CLIENT_WINS",
  "PROVIDER_WINS",
]);

export function runDeterministicExpiries(L: HoldLedgerOps): void {
  for (const h of L.holds.values()) {
    if (h.status !== "HELD") continue;
    const obl = L.obligations?.get(h.obligationId);
    // never auto-expire while dispute/delivery locks capital
    if (obl && obl.status === "DISPUTED") {
      const start = disputeClockStart(obl, h.createdHeight);
      if (L.height >= start + MAX_DISPUTE_HEIGHTS) {
        h.status = "RELEASED";
        obl.status = "CLIENT_WINS";
      }
      continue;
    }
    if (obl && EXPIRY_FROZEN_OBLIGATION.has(obl.status)) continue;
    const deadline =
      obl?.deliverByHeight ?? h.createdHeight + DEFAULT_HOLD_TTL_HEIGHTS;
    if (L.height >= deadline) {
      retainOpenFee(L, h);
      h.status = "EXPIRED";
      if (obl && obl.status === "OPEN") {
        obl.status = "EXPIRED";
      }
    }
  }
  if (L.obligations) {
    for (const obl of L.obligations.values()) {
      if (obl.status !== "OPEN") continue;
      if (L.height >= obl.deliverByHeight) {
        obl.status = "EXPIRED";
        const h = L.holds.get(obl.holdId);
        if (h && h.status === "HELD") {
          retainOpenFee(L, h);
          h.status = "EXPIRED";
        }
      }
    }
  }
}

export type HoldLedgerOps = {
  holds: Map<string, HoldRecord>;
  retiredHoldIds?: Set<string>;
  /** ECON-05: when present, hold_consume requires DELIVERED obligation */
  obligations?: Map<string, import("./uep-econ-05.ts").ObligationRecord>;
  height: number;
  balance(id: string): bigint;
  ensure(id: string, bal?: bigint): void;
  getTreasury(): bigint;
  setTreasury(v: bigint): void;
  setBalance(id: string, v: bigint): void;
};

/**
 * Apply one protocol tx against a mutable ledger view (used inside applyTransfers).
 * Caller owns snapshot/rollback.
 */

/** non-refundable protocol fee on abandon/cancel. */
function retainOpenFee(L: HoldLedgerOps, h: HoldRecord): void {
  if (h.feeLocked <= 0n) return;
  L.ensure(h.clientId);
  const bal = L.balance(h.clientId);
  const take = bal < h.feeLocked ? bal : h.feeLocked;
  if (take <= 0n) return;
  L.setBalance(h.clientId, bal - take);
  L.setTreasury(L.getTreasury() + take);
}

export function applyProtocolTx(
  L: HoldLedgerOps,
  tx: ProtocolBatchTx,
): { ok: true } | { ok: false; reason: string } {
  const kind: TxKind = tx.kind ?? "transfer";

  if (kind !== "transfer") {
    // Lab default so JSON/wire bodies that omit scope still apply locally.
    // Secure profiles bind domain in authorizeBatchTx (A2), not here.
    if (!tx.networkId) tx.networkId = LAB_ECON_NETWORK;
    if (tx.domainId === undefined) tx.domainId = LAB_ECON_DOMAIN;
  }

  if (kind === "hold_open") {
    if (!tx.holdId || !tx.obligationId || tx.price === undefined || !tx.providerId) {
      return { ok: false, reason: "HOLD_OPEN_BAD_FIELDS" };
    }
    if (L.holds.has(tx.holdId) || L.retiredHoldIds?.has(tx.holdId)) {
      return { ok: false, reason: "HOLD_EXISTS" };
    }
    if (tx.price < MIN_HOLD_PRICE) return { ok: false, reason: "HOLD_PRICE_BELOW_MINIMUM" };
    const feeLocked =
      creatorFee(tx.price) >= MIN_OPEN_FEE ? creatorFee(tx.price) : MIN_OPEN_FEE;
    const locked = tx.price + feeLocked;
    const bal = L.balance(tx.from);
    const held = totalHeldFor(L.holds, tx.from);
    if (bal - held < locked) return { ok: false, reason: "INSUFFICIENT_AVAILABLE" };
    L.holds.set(tx.holdId, {
      holdId: tx.holdId,
      obligationId: tx.obligationId,
      clientId: tx.from,
      providerId: tx.providerId,
      price: tx.price,
      feeLocked,
      locked,
      status: "HELD",
      createdHeight: L.height,
    });
    return { ok: true };
  }

  if (kind === "hold_release") {
    if (!tx.holdId) return { ok: false, reason: "HOLD_RELEASE_BAD_FIELDS" };
    const h = L.holds.get(tx.holdId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    if (h.clientId !== tx.from) return { ok: false, reason: "HOLD_NOT_OWNER" };
    const obl = L.obligations?.get(h.obligationId);
    if (obl && EXPIRY_FROZEN_OBLIGATION.has(obl.status) && obl.status !== "OPEN") {
      return { ok: false, reason: `HOLD_RELEASE_FROZEN:${obl.status}` };
    }
    // retain feeLocked to treasury on cancel (anti-spam)
    retainOpenFee(L, h);
    h.status = "RELEASED";
    if (obl && obl.status === "OPEN") obl.status = "CANCELLED";
    return { ok: true };
  }

  if (kind === "hold_consume") {
    if (!tx.holdId || tx.price === undefined) {
      return { ok: false, reason: "HOLD_CONSUME_BAD_FIELDS" };
    }
    const h = L.holds.get(tx.holdId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    if (h.price !== tx.price) return { ok: false, reason: "HOLD_PRICE_MISMATCH" };
    const provider = tx.providerId ?? h.providerId;
    if (provider !== h.providerId) return { ok: false, reason: "HOLD_PROVIDER_MISMATCH" };
    const isClient = tx.from === h.clientId;
    const isProvider = tx.from === h.providerId;
    if (!isClient && !isProvider) return { ok: false, reason: "HOLD_SETTLE_UNAUTHORIZED" };
    // ECON-05 P3: if an obligation record exists for this hold, it must be DELIVERED
    if (L.obligations) {
      const oblId = tx.obligationId ?? h.obligationId;
      const obl = L.obligations.get(oblId);
      if (obl) {
        if (obl.holdId !== h.holdId) return { ok: false, reason: "HOLD_OBLIGATION_MISMATCH" };
        if (obl.status !== "DELIVERED") {
          return { ok: false, reason: `OBLIGATION_NOT_DELIVERED:${obl.status}` };
        }
        if (obl.providerId !== provider) return { ok: false, reason: "OBLIGATION_PROVIDER_MISMATCH" };
        if (obl.price !== tx.price) return { ok: false, reason: "OBLIGATION_PRICE_MISMATCH" };
        // provider cannot settle during inspection window
        if (isProvider) {
          const until = obl.inspectionUntilHeight ?? 0;
          if (L.height < until) {
            return { ok: false, reason: `INSPECTION_WINDOW:${L.height}<${until}` };
          }
        }
        obl.status = "SETTLED";
        obl.settlementTxId = tx.id;
      } else if (isProvider) {
        return { ok: false, reason: "PROVIDER_SETTLE_REQUIRES_OBLIGATION" };
      }
    }

    L.ensure(h.clientId);
    L.ensure(provider);
    const fee = h.feeLocked;
    const total = h.price + fee;
    const fromBal = L.balance(h.clientId);
    // Consume always debits the client (locked funds), whoever submits settle
    if (fromBal < total) return { ok: false, reason: "INSUFFICIENT" };
    L.setBalance(h.clientId, fromBal - total);
    L.setBalance(provider, L.balance(provider) + h.price);
    L.setTreasury(L.getTreasury() + fee);
    h.status = "CONSUMED";
    return { ok: true };
  }


  if (kind === "hold_resolve") {
    // resolve DISPUTED → CLIENT_WINS (refund) or PROVIDER_WINS (pay)
    if (!tx.holdId || !tx.obligationId) {
      return { ok: false, reason: "HOLD_RESOLVE_BAD_FIELDS" };
    }
    const outcome = (tx as { resolveOutcome?: string }).resolveOutcome;
    if (outcome !== "CLIENT_WINS" && outcome !== "PROVIDER_WINS") {
      return { ok: false, reason: "HOLD_RESOLVE_BAD_OUTCOME" };
    }
    const h = L.holds.get(tx.holdId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    const obl = L.obligations?.get(tx.obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status !== "DISPUTED") {
      return { ok: false, reason: `OBLIGATION_NOT_DISPUTED:${obl.status}` };
    }
    const start = disputeClockStart(obl, h.createdHeight);
    if (L.height >= start + MAX_DISPUTE_HEIGHTS) {
      return { ok: false, reason: "DISPUTE_TIMED_OUT" };
    }
    if (obl.holdId !== h.holdId) return { ok: false, reason: "HOLD_OBLIGATION_MISMATCH" };
    // ECON-05.2.5: no anonymous arbiter. Only a concession by a party.
    // client may concede PROVIDER_WINS; provider may concede CLIENT_WINS.
    const from = tx.from;
    if (from !== h.clientId && from !== h.providerId) {
      return { ok: false, reason: "HOLD_RESOLVE_UNAUTHORIZED" };
    }
    if (from === h.clientId && outcome !== "PROVIDER_WINS") {
      return { ok: false, reason: "RESOLVE_SELF_AWARD" };
    }
    if (from === h.providerId && outcome !== "CLIENT_WINS") {
      return { ok: false, reason: "RESOLVE_SELF_AWARD" };
    }
    if (outcome === "CLIENT_WINS") {
      // refund: release hold, no payment
      h.status = "RELEASED";
      obl.status = "CLIENT_WINS";
      obl.settlementTxId = tx.id;
      return { ok: true };
    }
    // PROVIDER_WINS: same as consume
    const provider = h.providerId;
    L.ensure(h.clientId);
    L.ensure(provider);
    const fee = h.feeLocked;
    const total = h.price + fee;
    const fromBal = L.balance(h.clientId);
    if (fromBal < total) return { ok: false, reason: "INSUFFICIENT" };
    L.setBalance(h.clientId, fromBal - total);
    L.setBalance(provider, L.balance(provider) + h.price);
    L.setTreasury(L.getTreasury() + fee);
    h.status = "CONSUMED";
    obl.status = "PROVIDER_WINS";
    obl.settlementTxId = tx.id;
    return { ok: true };
  }

  if (kind === "hold_expire") {
    if (!tx.holdId) return { ok: false, reason: "HOLD_EXPIRE_BAD_FIELDS" };
    const h = L.holds.get(tx.holdId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    const obl = L.obligations?.get(h.obligationId);
    if (obl && EXPIRY_FROZEN_OBLIGATION.has(obl.status)) {
      return { ok: false, reason: `HOLD_EXPIRY_FROZEN:${obl.status}` };
    }
    const deadline =
      obl?.deliverByHeight ?? h.createdHeight + DEFAULT_HOLD_TTL_HEIGHTS;
    if (L.height < deadline) return { ok: false, reason: "HOLD_NOT_YET_EXPIRED" };
    retainOpenFee(L, h);
    h.status = "EXPIRED";
    if (obl && obl.status === "OPEN") obl.status = "EXPIRED";
    return { ok: true };
  }

  // transfer: spend only from available
  if (tx.amount <= 0n) return { ok: false, reason: "BAD_AMOUNT" };
  L.ensure(tx.from);
  L.ensure(tx.to);
  const fee = creatorFee(tx.amount);
  const total = tx.amount + fee;
  const fromBal = L.balance(tx.from);
  const held = totalHeldFor(L.holds, tx.from);
  if (fromBal - held < total) return { ok: false, reason: "INSUFFICIENT_AVAILABLE" };
  L.setBalance(tx.from, fromBal - total);
  L.setBalance(tx.to, L.balance(tx.to) + tx.amount);
  L.setTreasury(L.getTreasury() + fee);
  return { ok: true };
}
