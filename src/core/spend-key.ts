/**
 * Publicly verifiable sender authentication for testnet spends (v0.4.4, UEP-B06/A06).
 *
 * Each identity has a deterministic Ed25519 "spend key" derived from its
 * account secret and salt. The key is registered on a ledger by proving
 * control of the account (the ledger checks hAccount(secret, salt)). Every
 * spend envelope carries a sender signature over its txId and commitment, so
 * a node that never sees the sender's secret (pending reconciliation,
 * restore, replicas) can still authenticate the sender.
 *
 * This does not replace the development MAC used by submit(); it adds a
 * verifiable signature alongside it.
 *
 * Status: IMPLEMENTED / TESTED (testnet; deterministic derivation, no HSM).
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import type { Fr } from "./field.ts";
import { publicKeyHexOf, sha256Hex, signEd25519, stableStringify, verifyEd25519 } from "./ed25519.ts";

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

export type SenderAuth = { publicKey: string; signature: string };
export type SpendKeyRegistration = { account: string; publicKey: string; proof: string };

/** Deterministic Ed25519 spend key for an identity (never leaves the holder). */
export function deriveSpendKey(secret: Fr, salt: Fr): { privateKey: KeyObject; publicKeyHex: string } {
  const seed = sha256Hex(`UEP-SPEND-KEY-v1\n${secret.toHex()}\n${salt.toHex()}`);
  const privateKey = createPrivateKey({ key: Buffer.from(PKCS8_ED25519_PREFIX + seed, "hex"), format: "der", type: "pkcs8" });
  return { privateKey, publicKeyHex: publicKeyHexOf(privateKey) };
}

/** Message signed by the sender for one transaction envelope. */
export function senderAuthMessage(tx: { networkId: string; domainId: string; txId: Fr; senderId: Fr; transactionCommitment: Fr }): string {
  return stableStringify({ domain: "UEP-TX-SENDER-v1", networkId: tx.networkId, domainId: tx.domainId, txId: tx.txId.toHex(), senderId: tx.senderId.toHex(), transactionCommitment: tx.transactionCommitment.toHex() });
}

export function signSenderAuth(tx: Parameters<typeof senderAuthMessage>[0], secret: Fr, salt: Fr): SenderAuth {
  const key = deriveSpendKey(secret, salt);
  return { publicKey: key.publicKeyHex, signature: signEd25519(senderAuthMessage(tx), key.privateKey) };
}

export function verifySenderAuth(tx: Parameters<typeof senderAuthMessage>[0] & { senderAuth?: SenderAuth }, registeredPublicKey: string | undefined): boolean {
  if (!registeredPublicKey || !tx.senderAuth || tx.senderAuth.publicKey !== registeredPublicKey) return false;
  return verifyEd25519(senderAuthMessage(tx), tx.senderAuth.signature, registeredPublicKey);
}

/** Message proving possession of the spend key at registration time. */
export function spendKeyRegistrationMessage(networkId: string, accountHex: string): string {
  return stableStringify({ domain: "UEP-SPEND-KEY-REG-v1", networkId, account: accountHex });
}

export function verifySpendKeyRegistration(networkId: string, reg: SpendKeyRegistration): boolean {
  if (!reg || typeof reg.account !== "string" || typeof reg.publicKey !== "string" || typeof reg.proof !== "string") return false;
  return verifyEd25519(spendKeyRegistrationMessage(networkId, reg.account), reg.proof, reg.publicKey);
}
