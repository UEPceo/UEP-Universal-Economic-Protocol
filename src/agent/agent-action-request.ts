/**
 * UEP-Agent — Signed ActionRequest before payment (EXPERIMENTAL)
 *
 * Requirement: signature proves the payment request itself,
 * not only a post-hoc result string.
 */

import {
  type AgentCapability,
  type AgentKeypair,
  type AgentPermission,
  authorizeAgentAction,
  signAgent,
  verifyAgent,
} from "./agent-identity.ts";
import type { SignedCapability } from "./agent-capability-cert.ts";
import { verifySignedCapability } from "./agent-capability-cert.ts";
import type { AgentNonceStore } from "./agent-nonce.ts";

export type ActionRequest = {
  agentId: string;
  permission: AgentPermission;
  amount?: bigint;
  asset?: string;
  serviceId?: string;
  nonce: string;
  /** Monotonic sequence preferred when available */
  sequence?: number;
  ts: number;
};

export type SignedActionRequest = {
  request: ActionRequest;
  agentSignature: string;
};

export function actionRequestBody(req: ActionRequest): string {
  return [
    "UEP-AGENT-ACT-v1",
    req.agentId,
    req.permission,
    req.amount?.toString() ?? "",
    req.asset ?? "",
    req.serviceId ?? "",
    req.nonce,
    req.sequence !== undefined ? String(req.sequence) : "",
    String(req.ts),
  ].join("|");
}

export function signActionRequest(
  kp: AgentKeypair,
  request: ActionRequest,
): SignedActionRequest {
  if (kp.agentId !== request.agentId) {
    throw new Error("AGENT_ID_MISMATCH");
  }
  return {
    request,
    agentSignature: signAgent(kp, actionRequestBody(request)),
  };
}

export function verifyActionRequest(
  agentPublicKeyHex: string,
  signed: SignedActionRequest,
): boolean {
  return verifyAgent(
    agentPublicKeyHex,
    actionRequestBody(signed.request),
    signed.agentSignature,
  );
}

/**
 * Full gate: capability (optionally owner-signed) + nonce + action sig + authorize.
 */
export function authorizeSignedAction(opts: {
  signed: SignedActionRequest;
  capability: AgentCapability;
  signedCapability?: SignedCapability;
  nonces: AgentNonceStore;
}): { ok: true } | { ok: false; reason: string } {
  const { signed, capability, signedCapability, nonces } = opts;
  if (signed.request.agentId !== capability.agentId) {
    return { ok: false, reason: "AGENT_ID_MISMATCH" };
  }
  if (signedCapability) {
    const cv = verifySignedCapability(signedCapability);
    if (!cv.ok) return cv;
    if (signedCapability.capability.agentId !== capability.agentId) {
      return { ok: false, reason: "CAP_AGENT_MISMATCH" };
    }
  }
  if (!verifyActionRequest(capability.publicKeyHex, signed)) {
    return { ok: false, reason: "ACTION_SIG_INVALID" };
  }
  const nr = nonces.checkAndConsume(
    signed.request.agentId,
    signed.request.nonce,
    signed.request.sequence,
  );
  if (!nr.ok) return nr;
  return authorizeAgentAction(capability, {
    permission: signed.request.permission,
    amount: signed.request.amount,
    asset: signed.request.asset,
    serviceId: signed.request.serviceId,
  });
}
