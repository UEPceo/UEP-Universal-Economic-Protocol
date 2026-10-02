/**
 * UEP Phase A — S2-3: cryptographic authorization of the spending account.
 *
 * BatchTx may carry an Ed25519 signature over a canonical payload bound to
 * from|to|amount|id|nonce. Without a valid auth (when required), nodes reject.
 *
 * LAB: existing tests keep working with requireTxAuth=false (default).
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";

export const TX_AUTH_VERSION = "A1";

export type TxAuth = {
  /** SPKI hex of the authorizing key (must match registered account key when bound). */
  publicKeyHex: string;
  /** Opaque nonce / anti-replay per sender (also covered by signature). */
  nonce: string;
  signature: string;
};

export type AuthorizedBatchTx = BatchTx & { auth: TxAuth };

/** Canonical payload the holder signs. */
export function batchTxSignBody(tx: {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  nonce: string;
  networkId?: string;
  domainId?: number;
}): string {
  const scoped = Boolean(tx.networkId) || tx.domainId !== undefined;
  if (!scoped) {
    return [
      "UEP-TX-AUTH-A1",
      tx.id,
      tx.from,
      tx.to,
      tx.amount.toString(),
      tx.nonce,
    ].join("|");
  }
  return [
    "UEP-TX-AUTH-A2",
    tx.id,
    tx.from,
    tx.to,
    tx.amount.toString(),
    tx.nonce,
    tx.networkId ?? "",
    tx.domainId === undefined ? "" : String(tx.domainId),
  ].join("|");
}

export function signBatchTx(
  identity: NodeIdentity,
  tx: {
    id: string;
    from: string;
    to: string;
    amount: bigint;
    networkId?: string;
    domainId?: number;
  },
  nonce: string,
): AuthorizedBatchTx {
  const body = batchTxSignBody({ ...tx, nonce });
  const signature = signBytes(identity, body);
  return {
    ...tx,
    auth: {
      publicKeyHex: identity.publicKeyHex,
      nonce,
      signature,
    },
  };
}

export function verifyBatchTxAuth(tx: BatchTx): boolean {
  const auth = (tx as BatchTx & { auth?: TxAuth }).auth;
  if (!auth) return false;
  if (!auth.publicKeyHex || !auth.signature || !auth.nonce) return false;
  const body = batchTxSignBody({
    id: tx.id,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    nonce: auth.nonce,
    networkId: tx.networkId,
    domainId: tx.domainId,
  });
  return verifyBytes(auth.publicKeyHex, body, auth.signature);
}

/**
 * Optional binding: account label → expected publicKeyHex.
 * If map provided and from is present, key must match.
 */
export function authorizeBatchTx(
  tx: BatchTx,
  opts?: {
    requireAuth?: boolean;
    /** When true, sender MUST have an entry in accountKeys and it MUST match. */
    requireAccountKeyBinding?: boolean;
    accountKeys?: Record<string, string>;
    requireDomain?: boolean;
    expectedNetworkId?: string;
    expectedDomainId?: number;
  },
): { ok: true } | { ok: false; reason: string } {
  const requireAuth = opts?.requireAuth ?? false;
  const requireBind = opts?.requireAccountKeyBinding === true;
  const auth = (tx as BatchTx & { auth?: TxAuth }).auth;
  if (!auth) {
    if (requireAuth) return { ok: false, reason: "AUTH_REQUIRED" };
    return { ok: true };
  }
  if (!verifyBatchTxAuth(tx)) return { ok: false, reason: "AUTH_BAD_SIG" };
  if (requireBind) {
    const keys = opts?.accountKeys ?? {};
    const expected = keys[tx.from];
    if (!expected) return { ok: false, reason: "AUTH_NO_ACCOUNT_KEY" };
    if (expected !== auth.publicKeyHex) {
      return { ok: false, reason: "AUTH_KEY_MISMATCH" };
    }
  }
  if (opts?.requireDomain) {
    if (tx.networkId === undefined || tx.networkId === "") {
      return { ok: false, reason: "INVALID_OR_MISSING_NETWORK_ID" };
    }
    if (tx.domainId === undefined) {
      return { ok: false, reason: "INVALID_OR_MISSING_DOMAIN_ID" };
    }
    if (opts.expectedNetworkId !== undefined && tx.networkId !== opts.expectedNetworkId) {
      return { ok: false, reason: "NETWORK_MISMATCH" };
    }
    if (opts.expectedDomainId !== undefined && tx.domainId !== opts.expectedDomainId) {
      return { ok: false, reason: "DOMAIN_MISMATCH" };
    }
  }
  return { ok: true };
}
