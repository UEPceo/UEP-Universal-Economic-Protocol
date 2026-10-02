/**
 * UEP-Agent — Owner-signed capability certificate (EXPERIMENTAL)
 *
 * ownerId is no longer a free-form label only.
 * Owner key signs the capability payload; verifiers check owner signature.
 * Still NOT part of consensus / SpendCircuit.
 */

import {
  type AgentCapability,
  type AgentKeypair,
  type AgentPermission,
  createAgentKeypair,
  signAgent,
  verifyAgent,
} from "./agent-identity.ts";

export type OwnerKeypair = {
  ownerId: string;
  publicKeyHex: string;
  privateKey: import("node:crypto").KeyObject;
  publicKey: import("node:crypto").KeyObject;
};

export function createOwnerKeypair(ownerId: string): OwnerKeypair {
  const kp = createAgentKeypair(`owner:${ownerId}`);
  return {
    ownerId,
    publicKeyHex: kp.publicKeyHex,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
}

export type SignedCapability = {
  capability: AgentCapability;
  /** Owner public key that issued the grant */
  ownerPublicKeyHex: string;
  /** Ed25519 signature over capabilityBody */
  ownerSignature: string;
  /** Capability nonce / grant id for uniqueness */
  grantId: string;
};

export function capabilityBody(cap: AgentCapability, grantId: string): string {
  return [
    "UEP-AGENT-CAP-v1",
    grantId,
    cap.agentId,
    cap.publicKeyHex,
    cap.ownerId,
    cap.permissions.join(","),
    cap.spendingLimit.toString(),
    cap.remainingBudget.toString(),
    cap.allowedAssets.join(","),
    cap.allowedServices.join(","),
    String(cap.expiresAt),
    String(cap.createdAt),
    cap.revoked ? "1" : "0",
  ].join("|");
}

export function issueSignedCapability(opts: {
  owner: OwnerKeypair;
  agentId: string;
  agentPublicKeyHex: string;
  permissions: AgentPermission[];
  spendingLimit: bigint;
  allowedAssets: string[];
  allowedServices: string[];
  ttlMs: number;
  grantId?: string;
}): SignedCapability {
  const now = Date.now();
  const grantId = opts.grantId ?? `grant-${now}-${Math.random().toString(16).slice(2, 10)}`;
  const capability: AgentCapability = {
    agentId: opts.agentId,
    publicKeyHex: opts.agentPublicKeyHex,
    ownerId: opts.owner.ownerId,
    permissions: [...opts.permissions],
    spendingLimit: opts.spendingLimit,
    remainingBudget: opts.spendingLimit,
    allowedAssets: [...opts.allowedAssets],
    allowedServices: [...opts.allowedServices],
    expiresAt: opts.ttlMs > 0 ? now + opts.ttlMs : 0,
    revoked: false,
    createdAt: now,
  };
  const body = capabilityBody(capability, grantId);
  const ownerAsAgent: AgentKeypair = {
    agentId: opts.owner.ownerId,
    publicKeyHex: opts.owner.publicKeyHex,
    privateKey: opts.owner.privateKey,
    publicKey: opts.owner.publicKey,
  };
  const ownerSignature = signAgent(ownerAsAgent, body);
  return {
    capability,
    ownerPublicKeyHex: opts.owner.publicKeyHex,
    ownerSignature,
    grantId,
  };
}

export function verifySignedCapability(
  signed: SignedCapability,
): { ok: true } | { ok: false; reason: string } {
  if (signed.capability.revoked) return { ok: false, reason: "CAP_REVOKED" };
  if (
    signed.capability.expiresAt > 0 &&
    Date.now() > signed.capability.expiresAt
  ) {
    return { ok: false, reason: "CAP_EXPIRED" };
  }
  const body = capabilityBody(signed.capability, signed.grantId);
  if (!verifyAgent(signed.ownerPublicKeyHex, body, signed.ownerSignature)) {
    return { ok: false, reason: "OWNER_SIG_INVALID" };
  }
  // Bind: capability.ownerId must match what we trust externally is optional;
  // cryptographic trust is ownerPublicKeyHex + signature.
  return { ok: true };
}

/**
 * Reject forged capability: attacker public key + victim ownerId without owner sig.
 */
export function detectForgedOwnerLabel(
  signed: SignedCapability,
  trustedOwnerKeys: Map<string, string>, // ownerId → publicKeyHex
): { ok: true } | { ok: false; reason: string } {
  const expected = trustedOwnerKeys.get(signed.capability.ownerId);
  if (!expected) return { ok: false, reason: "UNKNOWN_OWNER" };
  if (expected !== signed.ownerPublicKeyHex) {
    return { ok: false, reason: "OWNER_KEY_MISMATCH" };
  }
  return verifySignedCapability(signed);
}
