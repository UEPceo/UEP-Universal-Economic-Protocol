/**
 * Key-derived accounts and publicly verifiable sender authentication
 * (v0.4.4 sender signatures; v0.4.5 key-derived account ids, UEP-ADDR-002).
 *
 * Each identity has a deterministic Ed25519 "spend key" derived from its
 * account secret and salt. Since v0.4.5 the account id itself commits to that
 * key:
 *
 *   accountId = 0x02 || SHA-256("UEP-ACCOUNT-KEY-v2\n" || raw32(spendPublicKey))[0..31]
 *
 * read as a 256-bit big-endian integer (always < 2^250, so it is a canonical
 * BN254 field element without reduction). The leading byte is the account-id
 * version. Every note owner is such an id, and a spend reveals the public key
 * and signs the envelope with it. Any node can therefore check
 * "key hashes to the input note owner and signed this transaction" without a
 * registry and without the sender's secret.
 *
 * The development MAC used by submit() with secrets is unchanged; it is an
 * additional check, not the source of public verifiability.
 *
 * Status: IMPLEMENTED / TESTED (testnet; deterministic derivation, no HSM).
 */
import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { Fr } from "./field.ts";
import { publicKeyHexOf, signEd25519, stableStringify, sha256Hex, toPublicKey, verifyEd25519, type PublicKeyLike } from "./ed25519.ts";

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

/** Version byte of key-derived account ids (and of v2 addresses). */
export const ACCOUNT_ID_VERSION = 0x02;
const ACCOUNT_KEY_DOMAIN = "UEP-ACCOUNT-KEY-v2\n";

export type SenderAuth = { publicKey: string; signature: string };

/** Deterministic Ed25519 spend key for an identity (never leaves the holder). */
export function deriveSpendKey(secret: Fr, salt: Fr): { privateKey: KeyObject; publicKeyHex: string } {
  const seed = sha256Hex(`UEP-SPEND-KEY-v1\n${secret.toHex()}\n${salt.toHex()}`);
  const privateKey = createPrivateKey({ key: Buffer.from(PKCS8_ED25519_PREFIX + seed, "hex"), format: "der", type: "pkcs8" });
  return { privateKey, publicKeyHex: publicKeyHexOf(privateKey) };
}

/** Raw 32-byte Ed25519 public key of any accepted public-key form. Throws on non-Ed25519 keys. */
export function rawEd25519PublicKey(publicKey: PublicKeyLike): Buffer {
  const spki = publicKeyHexOf(toPublicKey(publicKey));
  if (!spki.startsWith(SPKI_ED25519_PREFIX) || spki.length !== SPKI_ED25519_PREFIX.length + 64) throw new Error("SPEND_KEY_INVALID");
  return Buffer.from(spki.slice(SPKI_ED25519_PREFIX.length), "hex");
}

/** 31-byte key hash committed to by a v2 account id / address. */
export function spendKeyHash(publicKey: PublicKeyLike): Buffer {
  return createHash("sha256").update(Buffer.from(ACCOUNT_KEY_DOMAIN, "utf8")).update(rawEd25519PublicKey(publicKey)).digest().subarray(0, 31);
}

/** Account id that commits to an Ed25519 spend public key (UEP-ADDR-002). */
export function accountIdFromSpendKey(publicKey: PublicKeyLike): Fr {
  return accountIdFromKeyHash(spendKeyHash(publicKey));
}

/** Account id from a 31-byte key hash (as carried by a v2 address). */
export function accountIdFromKeyHash(keyHash: Uint8Array): Fr {
  if (keyHash.length !== 31) throw new Error("ACCOUNT_KEY_HASH_LENGTH");
  return Fr.fromBytesBE(Uint8Array.from([ACCOUNT_ID_VERSION, ...keyHash]));
}

/** 31-byte key hash of a key-derived account id (inverse of accountIdFromKeyHash). */
export function keyHashOfAccountId(accountId: Fr): Buffer {
  if (!isKeyDerivedAccountId(accountId)) throw new Error("ACCOUNT_NOT_KEY_DERIVED");
  return Buffer.from(accountId.n.toString(16).padStart(64, "0"), "hex").subarray(1);
}

/** True iff the id carries the v2 key-derived account version byte. */
export function isKeyDerivedAccountId(accountId: Fr): boolean {
  return accountId.n >> 248n === BigInt(ACCOUNT_ID_VERSION);
}

/** Account id of an identity's secrets: the id of its deterministic spend key. */
export function accountIdFromSecrets(secret: Fr, salt: Fr): Fr {
  return accountIdFromSpendKey(deriveSpendKey(secret, salt).publicKeyHex);
}

/** True iff `publicKey` is the key committed to by `accountId`. */
export function spendKeyMatchesAccount(publicKey: PublicKeyLike, accountId: Fr): boolean {
  try { return accountIdFromSpendKey(publicKey).eq(accountId); } catch { return false; }
}

/** Message signed by the sender for one transaction envelope. */
export function senderAuthMessage(tx: { networkId: string; domainId: string; txId: Fr; senderId: Fr; transactionCommitment: Fr }): string {
  return stableStringify({ domain: "UEP-TX-SENDER-v1", networkId: tx.networkId, domainId: tx.domainId, txId: tx.txId.toHex(), senderId: tx.senderId.toHex(), transactionCommitment: tx.transactionCommitment.toHex() });
}

export function signSenderAuth(tx: Parameters<typeof senderAuthMessage>[0], secret: Fr, salt: Fr): SenderAuth {
  const key = deriveSpendKey(secret, salt);
  return { publicKey: key.publicKeyHex, signature: signEd25519(senderAuthMessage(tx), key.privateKey) };
}

export type SenderAuthFailure = "MISSING" | "OWNER_KEY" | "SIGNATURE";

/**
 * Registry-free sender check: the revealed key must hash to `tx.senderId`
 * and must have signed the envelope. Returns undefined when valid.
 */
export function senderAuthFailure(tx: Parameters<typeof senderAuthMessage>[0] & { senderAuth?: SenderAuth }): SenderAuthFailure | undefined {
  const auth = tx.senderAuth;
  if (!auth || typeof auth.publicKey !== "string" || typeof auth.signature !== "string") return "MISSING";
  if (!spendKeyMatchesAccount(auth.publicKey, tx.senderId)) return "OWNER_KEY";
  return verifyEd25519(senderAuthMessage(tx), auth.signature, auth.publicKey) ? undefined : "SIGNATURE";
}

export function verifySenderAuth(tx: Parameters<typeof senderAuthFailure>[0]): boolean {
  return senderAuthFailure(tx) === undefined;
}
