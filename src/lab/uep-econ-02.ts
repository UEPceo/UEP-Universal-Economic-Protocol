/**
 * UEP-ECON-02 — Service settlement (lab)
 *
 * Bridge: offer → obligation → verifiable delivery → settlement TX
 * Settlement reuses ECON-01 fee/treasury/conservation via a normal BatchTx
 * (client → provider) finalized on MultiNodeCluster / existing economic state.
 *
 * NO BFT/ZK/Poseidon changes. NO native token.
 * Fee policy remains experimental creatorFee (ECON-01).
 *
 * Verification in this lab: resultDigest === expectedDigest (pre-agreed).
 * Production would plug oracles / ZK attestations / external proofs later.
 */

import { createHash } from "node:crypto";
import { canonicalId } from "./uep-canonical-encode.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  creatorFee,
  requiredSenderDebit,
  isEconomicallyMeaningfulAmount,
  ECON_01_MIN_MEANINGFUL_AMOUNT,
} from "./uep-econ-01.ts";

export const ECON_02_VERSION = "ECON-02";

export type ServiceOffer = {
  offerId: string;
  providerId: string;
  serviceKind: string;
  /** Price the client will pay the provider (gross before fee). */
  price: bigint;
  /** Pre-agreed digest of successful delivery (lab verification). */
  expectedResultDigest: string;
  /** Optional metadata (not consensus-critical). */
  meta?: Record<string, string>;
};

export type ObligationStatus =
  | "OPEN"
  | "DELIVERED"
  | "SETTLED"
  | "CANCELLED"
  | "DISPUTED";

export type ServiceObligation = {
  obligationId: string;
  offerId: string;
  clientId: string;
  providerId: string;
  serviceKind: string;
  price: bigint;
  expectedResultDigest: string;
  status: ObligationStatus;
  createdAt: number;
  deliveryDigest?: string;
  settlementTxId?: string;
};

export type DeliveryEvidence = {
  obligationId: string;
  providerId: string;
  resultDigest: string;
  /** Opaque payload hash only — lab does not store full result. */
  notedAt: number;
};

export type SettlementPlan = {
  obligationId: string;
  tx: BatchTx;
  fee: bigint;
  senderDebit: bigint;
  economicallyMeaningful: boolean;
};

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; reason: string };
export type Result<T> = Ok<T> | Err;

function digestHex(parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export function resultDigestFromPayload(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function makeOfferId(providerId: string, serviceKind: string, price: bigint, expected: string): string {
  return canonicalId(["OFFER", providerId, serviceKind, price.toString(), expected], 24);
}

export function makeObligationId(offerId: string, clientId: string, nonce: string): string {
  return canonicalId(["OBL", offerId, clientId, nonce], 24);
}

/**
 * In-memory lab registry. Not part of consensus state — records economic
 * intent until settlement produces a BatchTx that *does* enter economic state.
 */
export class ServiceSettlementLab {
  offers = new Map<string, ServiceOffer>();
  obligations = new Map<string, ServiceObligation>();
  deliveries = new Map<string, DeliveryEvidence>();
  settledTxIds = new Set<string>();
  clock = 0;

  registerOffer(input: {
    providerId: string;
    serviceKind: string;
    price: bigint;
    expectedResultDigest: string;
    meta?: Record<string, string>;
  }): Result<ServiceOffer> {
    if (input.price < 0n) return { ok: false, reason: "NEGATIVE_PRICE" };
    if (!input.providerId || !input.serviceKind) {
      return { ok: false, reason: "MISSING_FIELDS" };
    }
    if (!/^[0-9a-f]{64}$/i.test(input.expectedResultDigest)) {
      return { ok: false, reason: "BAD_EXPECTED_DIGEST" };
    }
    const offerId = makeOfferId(
      input.providerId,
      input.serviceKind,
      input.price,
      input.expectedResultDigest,
    );
    if (this.offers.has(offerId)) return { ok: false, reason: "OFFER_EXISTS" };
    const offer: ServiceOffer = {
      offerId,
      providerId: input.providerId,
      serviceKind: input.serviceKind,
      price: input.price,
      expectedResultDigest: input.expectedResultDigest,
      meta: input.meta,
    };
    this.offers.set(offerId, offer);
    return { ok: true, value: offer };
  }

  acceptOffer(input: {
    offerId: string;
    clientId: string;
    nonce: string;
  }): Result<ServiceObligation> {
    const offer = this.offers.get(input.offerId);
    if (!offer) return { ok: false, reason: "OFFER_NOT_FOUND" };
    if (!input.clientId) return { ok: false, reason: "NO_CLIENT" };
    if (input.clientId === offer.providerId) {
      return { ok: false, reason: "SELF_DEAL" };
    }
    const obligationId = makeObligationId(input.offerId, input.clientId, input.nonce);
    if (this.obligations.has(obligationId)) {
      return { ok: false, reason: "OBLIGATION_EXISTS" };
    }
    this.clock += 1;
    const obl: ServiceObligation = {
      obligationId,
      offerId: offer.offerId,
      clientId: input.clientId,
      providerId: offer.providerId,
      serviceKind: offer.serviceKind,
      price: offer.price,
      expectedResultDigest: offer.expectedResultDigest,
      status: "OPEN",
      createdAt: this.clock,
    };
    this.obligations.set(obligationId, obl);
    return { ok: true, value: obl };
  }

  submitDelivery(input: {
    obligationId: string;
    providerId: string;
    resultDigest: string;
  }): Result<DeliveryEvidence> {
    const obl = this.obligations.get(input.obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status !== "OPEN") return { ok: false, reason: `BAD_STATUS:${obl.status}` };
    if (input.providerId !== obl.providerId) {
      return { ok: false, reason: "NOT_PROVIDER" };
    }
    if (!/^[0-9a-f]{64}$/i.test(input.resultDigest)) {
      return { ok: false, reason: "BAD_RESULT_DIGEST" };
    }
    this.clock += 1;
    const evidence: DeliveryEvidence = {
      obligationId: input.obligationId,
      providerId: input.providerId,
      resultDigest: input.resultDigest,
      notedAt: this.clock,
    };
    this.deliveries.set(input.obligationId, evidence);
    obl.status = "DELIVERED";
    obl.deliveryDigest = input.resultDigest;
    return { ok: true, value: evidence };
  }

  /**
   * Verify delivery against pre-agreed digest and build settlement BatchTx.
   * Does NOT mutate economic chain state — caller must propose/finalize TX.
   */
  planSettlement(obligationId: string): Result<SettlementPlan> {
    const obl = this.obligations.get(obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status === "SETTLED") return { ok: false, reason: "ALREADY_SETTLED" };
    if (obl.status === "CANCELLED") return { ok: false, reason: "CANCELLED" };
    if (obl.status !== "DELIVERED") return { ok: false, reason: "NOT_DELIVERED" };

    const evidence = this.deliveries.get(obligationId);
    if (!evidence) return { ok: false, reason: "NO_EVIDENCE" };
    if (evidence.resultDigest !== obl.expectedResultDigest) {
      obl.status = "DISPUTED";
      return { ok: false, reason: "DIGEST_MISMATCH" };
    }

    const fee = creatorFee(obl.price);
    const tx: BatchTx = {
      id: `settle-${obligationId}`,
      from: obl.clientId,
      to: obl.providerId,
      amount: obl.price,
    };
    return {
      ok: true,
      value: {
        obligationId,
        tx,
        fee,
        senderDebit: requiredSenderDebit(obl.price),
        economicallyMeaningful: isEconomicallyMeaningfulAmount(obl.price),
      },
    };
  }

  /** Mark obligation settled after economic TX finalized (caller responsibility). */
  markSettled(obligationId: string, settlementTxId: string): Result<ServiceObligation> {
    const obl = this.obligations.get(obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status === "SETTLED") return { ok: false, reason: "ALREADY_SETTLED" };
    if (obl.status !== "DELIVERED") return { ok: false, reason: "NOT_DELIVERED" };
    if (this.settledTxIds.has(settlementTxId)) {
      return { ok: false, reason: "TX_ALREADY_USED" };
    }
    const evidence = this.deliveries.get(obligationId);
    if (!evidence || evidence.resultDigest !== obl.expectedResultDigest) {
      return { ok: false, reason: "DIGEST_MISMATCH" };
    }
    obl.status = "SETTLED";
    obl.settlementTxId = settlementTxId;
    this.settledTxIds.add(settlementTxId);
    return { ok: true, value: obl };
  }

  cancel(obligationId: string, by: string): Result<ServiceObligation> {
    const obl = this.obligations.get(obligationId);
    if (!obl) return { ok: false, reason: "OBLIGATION_NOT_FOUND" };
    if (obl.status !== "OPEN") return { ok: false, reason: `BAD_STATUS:${obl.status}` };
    if (by !== obl.clientId && by !== obl.providerId) {
      return { ok: false, reason: "NOT_PARTY" };
    }
    obl.status = "CANCELLED";
    return { ok: true, value: obl };
  }
}

export { creatorFee, requiredSenderDebit, ECON_01_MIN_MEANINGFUL_AMOUNT };
