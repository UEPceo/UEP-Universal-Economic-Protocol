/**
 * UEP-Agent Foundation — Identity & Authorization (EXPERIMENTAL)
 *
 * NOT part of consensus / SpendCircuit / wallet core.
 * Agents never hold unlimited wallet authority.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign, createPrivateKey, type KeyObject } from "node:crypto";
import { verifyEd25519 } from "../core/ed25519.ts";

export type AgentPermission =
  | "discover_services"
  | "compare_offers"
  | "contract_service"
  | "pay"
  | "verify_result"
  | "settle";

export type AgentCapability = {
  agentId: string;
  publicKeyHex: string;
  /** Human or org controller identity label (not a consensus key). */
  ownerId: string;
  permissions: AgentPermission[];
  /** Max spend per payment (smallest currency unit). */
  spendingLimit: bigint;
  /** Cumulative spend remaining in this grant window. */
  remainingBudget: bigint;
  allowedAssets: string[];
  allowedServices: string[];
  /** Unix ms; 0 = no expiry */
  expiresAt: number;
  revoked: boolean;
  createdAt: number;
};

export type AgentKeypair = {
  agentId: string;
  publicKeyHex: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export function createAgentKeypair(agentId: string): AgentKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  return { agentId, publicKeyHex, privateKey, publicKey };
}

export function signAgent(kp: AgentKeypair, body: string): string {
  return cryptoSign(null, Buffer.from(body, "utf8"), kp.privateKey).toString("hex");
}

export function verifyAgent(
  publicKeyHex: string,
  body: string,
  signatureHex: string,
): boolean {
  try {
    // v0.5.3: strict verification (prime-order key, canonical R and S).
    return verifyEd25519(Buffer.from(body, "utf8"), signatureHex.toLowerCase(), publicKeyHex);
  } catch {
    return false;
  }
}

export function issueCapability(opts: {
  agentId: string;
  publicKeyHex: string;
  ownerId: string;
  permissions: AgentPermission[];
  spendingLimit: bigint;
  allowedAssets: string[];
  allowedServices: string[];
  ttlMs: number;
}): AgentCapability {
  const now = Date.now();
  return {
    agentId: opts.agentId,
    publicKeyHex: opts.publicKeyHex,
    ownerId: opts.ownerId,
    permissions: [...opts.permissions],
    spendingLimit: opts.spendingLimit,
    remainingBudget: opts.spendingLimit,
    allowedAssets: [...opts.allowedAssets],
    allowedServices: [...opts.allowedServices],
    expiresAt: opts.ttlMs > 0 ? now + opts.ttlMs : 0,
    revoked: false,
    createdAt: now,
  };
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Authorization gate for agent actions. Never escalates permissions.
 */
export function authorizeAgentAction(
  cap: AgentCapability,
  action: {
    permission: AgentPermission;
    amount?: bigint;
    asset?: string;
    serviceId?: string;
  },
): AuthDecision {
  if (cap.revoked) return { ok: false, reason: "AGENT_REVOKED" };
  if (cap.expiresAt > 0 && Date.now() > cap.expiresAt) {
    return { ok: false, reason: "AGENT_EXPIRED" };
  }
  if (!cap.permissions.includes(action.permission)) {
    return { ok: false, reason: "PERMISSION_DENIED" };
  }
  if (action.serviceId && !cap.allowedServices.includes(action.serviceId) && !cap.allowedServices.includes("*")) {
    return { ok: false, reason: "SERVICE_NOT_ALLOWED" };
  }
  if (action.asset && !cap.allowedAssets.includes(action.asset) && !cap.allowedAssets.includes("*")) {
    return { ok: false, reason: "ASSET_NOT_ALLOWED" };
  }
  if (action.permission === "pay" && action.amount !== undefined) {
    if (action.amount <= 0n) return { ok: false, reason: "INVALID_AMOUNT" };
    if (action.amount > cap.spendingLimit) {
      return { ok: false, reason: "SPENDING_LIMIT_EXCEEDED" };
    }
    if (action.amount > cap.remainingBudget) {
      return { ok: false, reason: "BUDGET_EXCEEDED" };
    }
  }
  return { ok: true };
}

export function revokeCapability(cap: AgentCapability): AgentCapability {
  return { ...cap, revoked: true };
}

export function debitBudget(cap: AgentCapability, amount: bigint): AgentCapability {
  return {
    ...cap,
    remainingBudget: cap.remainingBudget - amount < 0n ? 0n : cap.remainingBudget - amount,
  };
}

/** Agents cannot self-modify permissions — only owner issues new capability. */
export function agentAttemptsPermissionChange(): AuthDecision {
  return { ok: false, reason: "AGENT_CANNOT_MODIFY_PERMISSIONS" };
}
