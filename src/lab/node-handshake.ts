/**
 * UEP-32.3 / 33.3 — Mutual authenticated peer handshake.
 *
 * HELLO → CHALLENGE → AUTH (initiator signs) → AUTH_OK (responder signs)
 *
 * Each HandshakeResponder instance is connection-scoped (no shared global nonce).
 */

import { randomBytes } from "node:crypto";
import type { NodeIdentity, NodeRegistry, NodeRole } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import { assertPeerRole } from "./peer-role.ts";

export type HelloMsg = {
  type: "hello";
  nodeId: string;
  publicKeyHex: string;
  networkId: string;
  domainId: number;
  role: NodeRole;
  sequence: number;
  stateRoot: string;
};

export type ChallengeMsg = {
  type: "challenge";
  nonce: string;
};

export type AuthMsg = {
  type: "auth";
  nodeId: string;
  nonce: string;
  signature: string;
};

export type AuthOkMsg = {
  type: "auth_ok";
  authenticatedNodeId: string;
  responderNodeId: string;
  nonce: string;
  networkId: string;
  domainId: number;
  role: NodeRole;
  /** Ed25519 signature by responder over canonical AUTH_OK body */
  signature: string;
};

export type AuthRejectMsg = {
  type: "auth_reject";
  reason: string;
};

export type HandshakeMessage =
  | HelloMsg
  | ChallengeMsg
  | AuthMsg
  | AuthOkMsg
  | AuthRejectMsg;

export function authOkBody(m: {
  authenticatedNodeId: string;
  responderNodeId: string;
  nonce: string;
  networkId: string;
  domainId: number;
  role: NodeRole;
}): string {
  return [
    "UEP-HS-OK",
    m.responderNodeId,
    m.authenticatedNodeId,
    m.nonce,
    m.networkId,
    String(m.domainId),
    m.role,
  ].join("|");
}

export function createHello(
  identity: NodeIdentity,
  opts: {
    networkId: string;
    domainId: number;
    role: NodeRole;
    sequence: number;
    stateRoot: string;
  },
): HelloMsg {
  return {
    type: "hello",
    nodeId: identity.nodeId,
    publicKeyHex: identity.publicKeyHex,
    networkId: opts.networkId,
    domainId: opts.domainId,
    role: opts.role,
    sequence: opts.sequence,
    stateRoot: opts.stateRoot,
  };
}

export function createChallenge(): ChallengeMsg {
  return { type: "challenge", nonce: randomBytes(32).toString("hex") };
}

export function createAuth(identity: NodeIdentity, nonce: string): AuthMsg {
  return {
    type: "auth",
    nodeId: identity.nodeId,
    nonce,
    signature: signBytes(identity, `UEP-HS|${identity.nodeId}|${nonce}`),
  };
}

export function verifyAuth(
  registry: NodeRegistry,
  auth: AuthMsg,
  expectedNonce: string,
  expectedNetwork: string,
  expectedDomain: number,
): { ok: true } | { ok: false; reason: string } {
  if (auth.nonce !== expectedNonce) return { ok: false, reason: "NONCE_MISMATCH" };
  const entry = registry.get(auth.nodeId);
  if (!entry) return { ok: false, reason: "UNKNOWN_NODE" };
  if (entry.status !== "active") return { ok: false, reason: "NODE_REVOKED" };
  if (entry.networkId !== expectedNetwork) {
    return { ok: false, reason: "NETWORK_MISMATCH" };
  }
  if (entry.domainId !== expectedDomain) {
    return { ok: false, reason: "DOMAIN_MISMATCH" };
  }
  const ok = verifyBytes(
    entry.publicKeyHex,
    `UEP-HS|${auth.nodeId}|${auth.nonce}`,
    auth.signature,
  );
  if (!ok) return { ok: false, reason: "BAD_AUTH_SIGNATURE" };
  return { ok: true };
}

/** Initiator verifies AUTH_OK is signed by the registered responder. */
export function verifyAuthOk(
  registry: NodeRegistry,
  msg: AuthOkMsg,
  expectedNonce: string,
  expectedNetwork: string,
  expectedDomain: number,
): { ok: true } | { ok: false; reason: string } {
  if (msg.nonce !== expectedNonce) return { ok: false, reason: "NONCE_MISMATCH" };
  if (msg.networkId !== expectedNetwork) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (msg.domainId !== expectedDomain) return { ok: false, reason: "DOMAIN_MISMATCH" };
  const entry = registry.get(msg.responderNodeId);
  if (!entry) return { ok: false, reason: "UNKNOWN_RESPONDER" };
  if (entry.status !== "active") return { ok: false, reason: "RESPONDER_REVOKED" };
  if (entry.role !== msg.role) return { ok: false, reason: "ROLE_MISMATCH" };
  if (entry.networkId !== expectedNetwork) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (entry.domainId !== expectedDomain) return { ok: false, reason: "DOMAIN_MISMATCH" };
  const body = authOkBody(msg);
  if (!verifyBytes(entry.publicKeyHex, body, msg.signature)) {
    return { ok: false, reason: "BAD_AUTH_OK_SIGNATURE" };
  }
  return { ok: true };
}

/**
 * Connection-scoped handshake state machine (one instance per socket).
 * Responder must hold its own NodeIdentity to sign AUTH_OK.
 */
export class HandshakeResponder {
  private registry: NodeRegistry;
  private networkId: string;
  private domainId: number;
  private responderIdentity: NodeIdentity;
  private localRole: NodeRole;
  private nonce: string | null = null;
  private pendingNodeId: string | null = null;

  constructor(
    registry: NodeRegistry,
    networkId: string,
    domainId: number,
    responderIdentity: NodeIdentity,
    localRole: NodeRole = "sequencer",
  ) {
    this.registry = registry;
    this.networkId = networkId;
    this.domainId = domainId;
    this.responderIdentity = responderIdentity;
    this.localRole = localRole;
  }

  onHello(hello: HelloMsg): ChallengeMsg | AuthRejectMsg {
    // One challenge per connection; second HELLO is rejected (no overwrite).
    if (this.nonce !== null) {
      return { type: "auth_reject", reason: "CHALLENGE_ALREADY_PENDING" };
    }
    const entry = this.registry.get(hello.nodeId);
    if (!entry) return { type: "auth_reject", reason: "UNKNOWN_NODE" };
    if (entry.status !== "active") return { type: "auth_reject", reason: "NODE_REVOKED" };
    if (hello.networkId !== this.networkId) {
      return { type: "auth_reject", reason: "NETWORK_MISMATCH" };
    }
    if (hello.domainId !== this.domainId) {
      return { type: "auth_reject", reason: "DOMAIN_MISMATCH" };
    }
    if (entry.publicKeyHex !== hello.publicKeyHex) {
      return { type: "auth_reject", reason: "PUBKEY_MISMATCH" };
    }
    if (hello.role !== entry.role) {
      return { type: "auth_reject", reason: "ROLE_MISMATCH: hello vs registry" };
    }
    const roleOk = assertPeerRole(this.localRole, entry.role);
    if (!roleOk.ok) {
      return { type: "auth_reject", reason: roleOk.reason };
    }
    const ch = createChallenge();
    this.nonce = ch.nonce;
    this.pendingNodeId = hello.nodeId;
    return ch;
  }

  onAuth(auth: AuthMsg): AuthOkMsg | AuthRejectMsg {
    if (!this.nonce || !this.pendingNodeId) {
      return { type: "auth_reject", reason: "NO_PENDING_CHALLENGE" };
    }
    if (auth.nodeId !== this.pendingNodeId) {
      return { type: "auth_reject", reason: "NODE_MISMATCH" };
    }
    const r = verifyAuth(
      this.registry,
      auth,
      this.nonce,
      this.networkId,
      this.domainId,
    );
    if (!r.ok) {
      this.nonce = null;
      this.pendingNodeId = null;
      return { type: "auth_reject", reason: r.reason };
    }
    const nonce = this.nonce;
    this.nonce = null;
    this.pendingNodeId = null;
    const partial = {
      authenticatedNodeId: auth.nodeId,
      responderNodeId: this.responderIdentity.nodeId,
      nonce,
      networkId: this.networkId,
      domainId: this.domainId,
      role: this.localRole,
    };
    return {
      type: "auth_ok",
      ...partial,
      signature: signBytes(this.responderIdentity, authOkBody(partial)),
    };
  }
}
