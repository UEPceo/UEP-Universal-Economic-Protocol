/**
 * UEP-ECON-03 — Client escrow / hold until delivery or cancel (lab)
 *
 * Builds on ECON-02 service obligations:
 *   accept → HOLD (price + fee) on client available balance
 *   deliver + settle → release hold + economic BatchTx (ECON-01)
 *   cancel (OPEN) → release hold, no payment
 *   dispute → hold remains until explicit release policy (lab: release to client)
 *
 * Holds are enforced by EscrowBook against an EconomicStateView.
 * They do NOT modify Poseidon/SMT/BFT; settlement TX still finalizes on-chain state.
 *
 * NO native token. Fee policy remains experimental creatorFee.
 */

import {
  ServiceSettlementLab,
  type ServiceObligation,
  type Result,
  type SettlementPlan,
} from "./uep-econ-02.ts";
import {
  creatorFee,
  requiredSenderDebit,
  type EconomicStateView,
} from "./uep-econ-01.ts";

export const ECON_03_VERSION = "ECON-03";

export type EscrowHold = {
  obligationId: string;
  clientId: string;
  /** Locked debit = price + fee (fee at time of accept). */
  amount: bigint;
  feeAtHold: bigint;
  price: bigint;
  status: "HELD" | "RELEASED" | "CONSUMED";
};

/**
 * Per-client holds. available = chainBalance - sum(HELD).
 */
export class EscrowBook {
  holds = new Map<string, EscrowHold>();

  totalHeld(clientId: string): bigint {
    let s = 0n;
    for (const h of this.holds.values()) {
      if (h.clientId === clientId && h.status === "HELD") s += h.amount;
    }
    return s;
  }

  available(clientId: string, chain: EconomicStateView): bigint {
    const bal = chain.balance(clientId);
    const held = this.totalHeld(clientId);
    return bal - held;
  }

  place(input: {
    obligationId: string;
    clientId: string;
    price: bigint;
  }): Result<EscrowHold> {
    if (this.holds.has(input.obligationId)) {
      return { ok: false, reason: "HOLD_EXISTS" };
    }
    const feeAtHold = creatorFee(input.price);
    const amount = requiredSenderDebit(input.price);
    const hold: EscrowHold = {
      obligationId: input.obligationId,
      clientId: input.clientId,
      amount,
      feeAtHold,
      price: input.price,
      status: "HELD",
    };
    this.holds.set(input.obligationId, hold);
    return { ok: true, value: hold };
  }

  /** Ensure available >= debit before placing (does not place). */
  canHold(
    clientId: string,
    price: bigint,
    chain: EconomicStateView,
  ): Result<bigint> {
    const need = requiredSenderDebit(price);
    const avail = this.available(clientId, chain);
    if (avail < need) {
      return {
        ok: false,
        reason: `INSUFFICIENT_AVAILABLE:${avail.toString()}/${need.toString()}`,
      };
    }
    return { ok: true, value: need };
  }

  release(obligationId: string): Result<EscrowHold> {
    const h = this.holds.get(obligationId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    h.status = "RELEASED";
    return { ok: true, value: h };
  }

  /** After settlement TX finalized — hold consumed (funds left via TX). */
  consume(obligationId: string): Result<EscrowHold> {
    const h = this.holds.get(obligationId);
    if (!h) return { ok: false, reason: "HOLD_NOT_FOUND" };
    if (h.status !== "HELD") return { ok: false, reason: `BAD_HOLD_STATUS:${h.status}` };
    h.status = "CONSUMED";
    return { ok: true, value: h };
  }
}

/**
 * ServiceSettlementLab + EscrowBook.
 * acceptOfferWithEscrow requires EconomicStateView for availability check.
 */
export class EscrowSettlementLab {
  services = new ServiceSettlementLab();
  escrow = new EscrowBook();

  registerOffer(
    input: Parameters<ServiceSettlementLab["registerOffer"]>[0],
  ): ReturnType<ServiceSettlementLab["registerOffer"]> {
    return this.services.registerOffer(input);
  }

  acceptWithEscrow(input: {
    offerId: string;
    clientId: string;
    nonce: string;
    chain: EconomicStateView;
  }): Result<{ obligation: ServiceObligation; hold: EscrowHold }> {
    const offer = this.services.offers.get(input.offerId);
    if (!offer) return { ok: false, reason: "OFFER_NOT_FOUND" };

    const can = this.escrow.canHold(input.clientId, offer.price, input.chain);
    if (!can.ok) return can;

    const obl = this.services.acceptOffer({
      offerId: input.offerId,
      clientId: input.clientId,
      nonce: input.nonce,
    });
    if (!obl.ok) return obl;

    const hold = this.escrow.place({
      obligationId: obl.value.obligationId,
      clientId: input.clientId,
      price: offer.price,
    });
    if (!hold.ok) {
      // should not happen; obligation already created — cancel to recover
      this.services.cancel(obl.value.obligationId, input.clientId);
      return hold;
    }
    return {
      ok: true,
      value: { obligation: obl.value, hold: hold.value },
    };
  }

  submitDelivery(
    input: Parameters<ServiceSettlementLab["submitDelivery"]>[0],
  ): ReturnType<ServiceSettlementLab["submitDelivery"]> {
    return this.services.submitDelivery(input);
  }

  planSettlement(obligationId: string): Result<SettlementPlan> {
    return this.services.planSettlement(obligationId);
  }

  /**
   * After economic TX success: consume hold + markSettled.
   */
  completeSettlement(
    obligationId: string,
    settlementTxId: string,
  ): Result<ServiceObligation> {
    // P1-1: markSettled first; only consume hold if SETTLED succeeds
    const settled = this.services.markSettled(obligationId, settlementTxId);
    if (!settled.ok) return settled;
    const consumed = this.escrow.consume(obligationId);
    if (!consumed.ok) {
      // Should not happen if hold was HELD; surface error but obligation already SETTLED
      // Revert obligation status to DELIVERED and clear settlementTxId for atomicity
      const obl = this.services.obligations.get(obligationId);
      if (obl) {
        obl.status = "DELIVERED";
        obl.settlementTxId = undefined;
        this.services.settledTxIds.delete(settlementTxId);
      }
      return { ok: false, reason: consumed.reason };
    }
    return settled;
  }

  cancelOpen(
    obligationId: string,
    by: string,
  ): Result<{ obligation: ServiceObligation; hold: EscrowHold }> {
    const cancelled = this.services.cancel(obligationId, by);
    if (!cancelled.ok) return cancelled;
    const rel = this.escrow.release(obligationId);
    if (!rel.ok) return rel;
    return {
      ok: true,
      value: { obligation: cancelled.value, hold: rel.value },
    };
  }

  /**
   * Lab policy on DISPUTED: release hold back to client availability
   * (no automatic refund TX — chain balance unchanged; only unlock).
   */
  releaseDisputed(obligationId: string): Result<EscrowHold> {
    const obl = this.services.obligations.get(obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status !== "DISPUTED") return { ok: false, reason: "NOT_DISPUTED" };
    return this.escrow.release(obligationId);
  }
}

export { creatorFee, requiredSenderDebit };
