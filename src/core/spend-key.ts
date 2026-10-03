/**
 * Key-derived accounts and publicly verifiable sender authentication
 * (v0.4.4 sender signatures; v0.4.5 key-derived account ids, UEP-ADDR-002).
 *
 * Each identity has a deterministic Ed25519 "spend key" derived from its
 * account secret and salt. The account id itself commits to that key.
 *
 * v3 (since v0.5.0, the format of every new id):
 *
 *   keyHash   = SHA-256("UEP-ACCOUNT-KEY-v3\n" || raw32(spendPublicKey))[0..23]
 *   check     = SHA-256("UEP-ACCOUNT-CHECK-v3\n" || 0x03 || keyHash)[0..8]
 *   accountId = 0x03 || keyHash || check          (32 bytes, big-endian)
 *
 * The version byte and the 64-bit check make the format self-identifying: a
 * legacy id H(secret, salt), which is close to uniform in the BN254 field,
 * passes isKeyDerivedAccountId() with probability 2^184 / r < 2^-69.
 * (v2 only had the version byte, so about 1 legacy id in 48 looked key-derived.)
 * The 23-byte key hash keeps 184-bit second-preimage and 92-bit collision
 * resistance; a collision only lets one party give two keys of its own the
 * same account.
 *
 * v2 (v0.4.5 to v0.5.0; still accepted for existing accounts):
 *
 *   accountId = 0x02 || SHA-256("UEP-ACCOUNT-KEY-v2\n" || raw32(spendPublicKey))[0..31]
 *
 * A v2 id cannot be told apart from a legacy id by its bytes alone. It is
 * proven by its key: a spend reveals the key and the ledger checks that it
 * hashes to the id. The ledger therefore accepts a v2 id as a recipient only
 * after that account has spent with a public signature (see UepLedger
 * acceptsRecipient), and always accepts it as a sender (the spend proves it).
 * Both ids of one spend key belong to the same holder (accountIdsOfSpendKey).
 *
 * Every id is < 2^250, so it is a canonical BN254 field element without
 * reduction. A spend reveals the public key and signs the envelope with it. Any node can therefore check
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

/** Version byte of new key-derived account ids (v3, with a 64-bit check) and of v3 addresses. */
export const ACCOUNT_ID_VERSION = 0x03;
/** Version byte of v2 key-derived ids (v0.4.5 to v0.5.0), still accepted for existing accounts. */
export const ACCOUNT_ID_VERSION_V2 = 0x02;
const ACCOUNT_KEY_DOMAIN_V2 = "UEP-ACCOUNT-KEY-v2\n";
const ACCOUNT_KEY_DOMAIN_V3 = "UEP-ACCOUNT-KEY-v3\n";
const ACCOUNT_CHECK_DOMAIN_V3 = "UEP-ACCOUNT-CHECK-v3\n";
const V3_KEY_HASH_BYTES = 23;
const V3_CHECK_BYTES = 8;

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

/** 31-byte key hash committed to by a v2 account id / address (v0.4.5 to v0.5.0). */
export function spendKeyHashV2(publicKey: PublicKeyLike): Buffer {
  return createHash("sha256").update(Buffer.from(ACCOUNT_KEY_DOMAIN_V2, "utf8")).update(rawEd25519PublicKey(publicKey)).digest().subarray(0, 31);
}

/** @deprecated name of spendKeyHashV2 (the v2 key hash). */
export const spendKeyHash = spendKeyHashV2;

function v3Check(keyHash: Uint8Array): Buffer {
  return createHash("sha256").update(Buffer.from(ACCOUNT_CHECK_DOMAIN_V3, "utf8")).update(Uint8Array.from([ACCOUNT_ID_VERSION, ...keyHash])).digest().subarray(0, V3_CHECK_BYTES);
}

/** 31-byte body of a v3 account id: 23-byte key hash || 8-byte check (as carried by a v3 address). */
export function spendKeyBodyV3(publicKey: PublicKeyLike): Buffer {
  const keyHash = createHash("sha256").update(Buffer.from(ACCOUNT_KEY_DOMAIN_V3, "utf8")).update(rawEd25519PublicKey(publicKey)).digest().subarray(0, V3_KEY_HASH_BYTES);
  return Buffer.concat([keyHash, v3Check(keyHash)]);
}

/** v3 account id that commits to an Ed25519 spend public key (the format of every new id). */
export function accountIdFromSpendKey(publicKey: PublicKeyLike): Fr {
  return Fr.fromBytesBE(Uint8Array.from([ACCOUNT_ID_VERSION, ...spendKeyBodyV3(publicKey)]));
}

/** v2 account id of the same key (v0.4.5 to v0.5.0); kept so existing accounts stay usable. */
export function accountIdFromSpendKeyV2(publicKey: PublicKeyLike): Fr {
  return Fr.fromBytesBE(Uint8Array.from([ACCOUNT_ID_VERSION_V2, ...spendKeyHashV2(publicKey)]));
}

/** Both ids of one spend key: the current v3 id and the v2 id of existing accounts. */
export function accountIdsOfSpendKey(publicKey: PublicKeyLike): { v3: Fr; v2: Fr } {
  return { v3: accountIdFromSpendKey(publicKey), v2: accountIdFromSpendKeyV2(publicKey) };
}

/**
 * Account id from the 31-byte body carried by an address: version 3 → the v3
 * id (the check must verify, else ACCOUNT_ID_CHECK); version 2 → the v2 id.
 */
export function accountIdFromKeyHash(body: Uint8Array, version: number = ACCOUNT_ID_VERSION): Fr {
  if (body.length !== 31) throw new Error("ACCOUNT_KEY_HASH_LENGTH");
  if (version !== ACCOUNT_ID_VERSION && version !== ACCOUNT_ID_VERSION_V2) throw new Error("ACCOUNT_ID_VERSION");
  const id = Fr.fromBytesBE(Uint8Array.from([version, ...body]));
  if (version === ACCOUNT_ID_VERSION && !isKeyDerivedAccountId(id)) throw new Error("ACCOUNT_ID_CHECK");
  return id;
}

function idBytes(accountId: Fr): Buffer {
  return Buffer.from(accountId.n.toString(16).padStart(64, "0"), "hex");
}

/** 31-byte body of a v3 or v2 key-derived account id (inverse of accountIdFromKeyHash). */
export function keyHashOfAccountId(accountId: Fr): Buffer {
  if (!isKeyDerivedAccountId(accountId) && !isV2AccountIdForm(accountId)) throw new Error("ACCOUNT_NOT_KEY_DERIVED");
  return idBytes(accountId).subarray(1);
}

/**
 * True iff the id is a v3 key-derived id: version byte 0x03 and a valid
 * 64-bit check. A legacy id passes with probability below 2^-69.
 */
export function isKeyDerivedAccountId(accountId: Fr): boolean {
  if (accountId.n >> 248n !== BigInt(ACCOUNT_ID_VERSION)) return false;
  const bytes = idBytes(accountId);
  return v3Check(bytes.subarray(1, 1 + V3_KEY_HASH_BYTES)).equals(bytes.subarray(1 + V3_KEY_HASH_BYTES));
}

/**
 * True iff the id has the v2 form (version byte 0x02). This alone does not
 * prove it is key-derived: about 1 legacy id in 48 has the same byte. The key
 * proves it (spendKeyMatchesAccount).
 */
export function isV2AccountIdForm(accountId: Fr): boolean {
  return accountId.n >> 248n === BigInt(ACCOUNT_ID_VERSION_V2);
}

/** The id format: "v3", "v2-form" (key-derived v2 or legacy, unprovable without the key) or "legacy". */
export function accountIdFormat(accountId: Fr): "v3" | "v2-form" | "legacy" {
  return isKeyDerivedAccountId(accountId) ? "v3" : isV2AccountIdForm(accountId) ? "v2-form" : "legacy";
}

/** Account id of an identity's secrets: the v3 id of its deterministic spend key. */
export function accountIdFromSecrets(secret: Fr, salt: Fr): Fr {
  return accountIdFromSpendKey(deriveSpendKey(secret, salt).publicKeyHex);
}

/** v3 and v2 ids of an identity's secrets (one spend key, one holder). */
export function accountIdsFromSecrets(secret: Fr, salt: Fr): { v3: Fr; v2: Fr } {
  return accountIdsOfSpendKey(deriveSpendKey(secret, salt).publicKeyHex);
}

/** True iff `publicKey` is the key committed to by `accountId` (v3, or v2 for existing accounts). */
export function spendKeyMatchesAccount(publicKey: PublicKeyLike, accountId: Fr): boolean {
  try {
    if (isKeyDerivedAccountId(accountId)) return accountIdFromSpendKey(publicKey).eq(accountId);
    if (isV2AccountIdForm(accountId)) return accountIdFromSpendKeyV2(publicKey).eq(accountId);
    return false;
  } catch { return false; }
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
