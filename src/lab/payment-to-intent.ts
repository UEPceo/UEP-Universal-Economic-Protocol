/**
 * PaymentRequest → SpendIntent bridge (UEP-ADDR-003 + engine).
 */

import { Fr } from "../core/field.ts";
import {
  type PaymentRequest,
  type MerchantMacKey,
  verifyPaymentRequestMac,
  isPaymentRequestExpired,
  decodePaymentRequestUri,
} from "./payment-request.ts";
import type { ExecutionEngine, SpendIntent } from "./execution-engine.ts";
import type { NetworkId } from "./address-v2.ts";

/** Map engine profile → address network_id. */
export function profileToNetworkId(
  profile: "dev" | "local" | "testnet",
): NetworkId {
  if (profile === "dev") return "dev";
  if (profile === "local") return "local";
  return "testnet";
}

export type PayEnqueueResult =
  | { ok: true; intent: SpendIntent }
  | { ok: false; error: string };

/**
 * Validate payment request and enqueue a spend from `fromLabel` to the
 * account whose `id` matches `pr.addressId`.
 */
export function enqueueFromPaymentRequest(
  eng: ExecutionEngine,
  fromLabel: string,
  pr: PaymentRequest,
  merchant: MerchantMacKey,
  opts?: { intentId?: string; allowExpired?: boolean; requireAmount?: boolean },
): PayEnqueueResult {
  if (!verifyPaymentRequestMac(pr, merchant)) {
    return { ok: false, error: "PAYMENT_MAC_INVALID" };
  }
  if (!opts?.allowExpired && isPaymentRequestExpired(pr)) {
    return { ok: false, error: "PAYMENT_EXPIRED" };
  }
  const expectedNet = profileToNetworkId(eng.config.profile);
  if (pr.networkId !== expectedNet) {
    return {
      ok: false,
      error: `PAYMENT_NETWORK_MISMATCH: req=${pr.networkId} engine=${expectedNet}`,
    };
  }
  if (eng.config.domainCode !== undefined && pr.domainCode !== eng.config.domainCode) {
    return {
      ok: false,
      error: `PAYMENT_DOMAIN_MISMATCH: req=${pr.domainCode} engine=${eng.config.domainCode}`,
    };
  }
  const requireAmount = opts?.requireAmount !== false;
  if (requireAmount && (pr.amount === undefined || pr.amount <= 0n)) {
    return { ok: false, error: "PAYMENT_AMOUNT_REQUIRED" };
  }
  if (pr.amount !== undefined && pr.amount <= 0n) {
    return { ok: false, error: "PAYMENT_AMOUNT_INVALID" };
  }

  const toLabel = eng.findAccountLabelById(pr.addressId);
  if (!toLabel) {
    return { ok: false, error: "PAYMENT_RECIPIENT_UNKNOWN" };
  }
  if (toLabel === fromLabel) {
    return { ok: false, error: "PAYMENT_SELF_TRANSFER" };
  }

  // Anti-replay: same orderId or same MAC cannot be paid twice on this engine.
  const replayKey =
    pr.orderId != null && pr.orderId !== ""
      ? `order:${pr.networkId}:${pr.domainCode}:${pr.orderId}`
      : pr.mac
        ? `mac:${pr.mac}`
        : null;
  if (replayKey && eng.isPaymentKeyConsumed(replayKey)) {
    return { ok: false, error: "PAYMENT_REPLAY" };
  }

  const intent: SpendIntent = {
    id: opts?.intentId ?? `pay-${pr.orderId ?? pr.mac?.slice(0, 12) ?? Date.now()}`,
    from: fromLabel,
    to: toLabel,
    amount: pr.amount!,
  };
  const enq = eng.enqueue(intent);
  if (!enq.ok) {
    return { ok: false, error: (enq as { error: string }).error };
  }
  if (replayKey) eng.markPaymentKeyConsumed(replayKey);
  return { ok: true, intent };
}

/** Decode URI, verify merchant, enqueue. */
export function enqueueFromPaymentUri(
  eng: ExecutionEngine,
  fromLabel: string,
  uri: string,
  merchant: MerchantMacKey,
  opts?: { intentId?: string; allowExpired?: boolean },
): PayEnqueueResult {
  const pr = decodePaymentRequestUri(uri, merchant);
  if (!pr) {
    return { ok: false, error: "PAYMENT_URI_INVALID_OR_MAC" };
  }
  return enqueueFromPaymentRequest(eng, fromLabel, pr, merchant, opts);
}

/** Resolve Fr id used for recipient binding. */
export function paymentRecipientId(pr: PaymentRequest): Fr {
  return pr.addressId;
}
