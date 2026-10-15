/**
 * 0.5.83: zk accounts. The spend circuit proves ownership of the account id
 * H_ACCOUNT(secret, salt); the ledger's Ed25519 accounts use a key-derived id.
 * A zk account is the H_ACCOUNT id of an identity, linked once to that
 * identity's Ed25519 account by a signed link record (domain-separated, bound
 * to network and domain). A linked zk account can receive transfers, and it
 * spends only through a v6 zk-spend whose proof is its authorization:
 * PI[4] = the zk account id, PI[10] = the transaction nullifier (circuit
 * nullifier H_NULLIFIER(secret, nonce)).
 */
import { Fr } from "./field.ts";
import { hAccount, hLeaf } from "./hash.ts";
import { encodeStringToFr } from "./encoding.ts";
import { makeNote, type Note } from "./note.ts";
import { signEd25519, verifyEd25519 } from "./ed25519.ts";
import { deriveSpendKey, spendKeyMatchesAccount } from "./spend-key.ts";

export const ZK_LINK_DOMAIN = "UEP-ZK-ACCOUNT-LINK-v1";

export type ZkAccountLink = { accountId: string; zkAccountId: string; publicKey: string; signature: string };

/** Circuit account id of an identity: H_ACCOUNT(secret, salt). */
export function zkAccountIdOf(secret: Fr, salt: Fr): Fr {
  return hAccount(secret, salt);
}

export function zkLinkMessage(networkId: string, domainId: string, accountId: Fr, zkAccountId: Fr): string {
  return `${ZK_LINK_DOMAIN}\n${networkId}\n${domainId}\n${accountId.toHex()}\n${zkAccountId.toHex()}`;
}

/** Wallet side: link record for the identity's own zk account, signed with its spend key. */
export function signZkAccountLink(id: { secret: Fr; salt: Fr; accountId: Fr }, networkId: string, domainId: string): ZkAccountLink {
  const key = deriveSpendKey(id.secret, id.salt);
  const zk = zkAccountIdOf(id.secret, id.salt);
  return { accountId: id.accountId.toHex(), zkAccountId: zk.toHex(), publicKey: key.publicKeyHex, signature: signEd25519(zkLinkMessage(networkId, domainId, id.accountId, zk), key.privateKey) };
}

const frOf = (h: string) => new Fr(BigInt(h.startsWith("0x") ? h : `0x${h}`));

/** Ledger side: the key hashes to the account and signed this exact link. Returns an error code or undefined. */
export function zkAccountLinkError(link: ZkAccountLink, networkId: string, domainId: string): string | undefined {
  if (!link || typeof link.accountId !== "string" || typeof link.zkAccountId !== "string" || typeof link.publicKey !== "string" || typeof link.signature !== "string") return "ZK_LINK_SHAPE";
  let account: Fr, zk: Fr;
  try { account = frOf(link.accountId); zk = frOf(link.zkAccountId); } catch { return "ZK_LINK_SHAPE"; }
  if (account.eq(zk)) return "ZK_LINK_SHAPE";
  if (!spendKeyMatchesAccount(link.publicKey, account)) return "ZK_LINK_OWNER_KEY";
  let ok = false;
  try { ok = verifyEd25519(zkLinkMessage(networkId, domainId, account, zk), link.signature, link.publicKey); } catch { ok = false; }
  return ok ? undefined : "ZK_LINK_SIGNATURE";
}

export const ZK_EXIT_NOTE_DOMAIN = "UEP-ZK-EXIT-NOTE-v1";

/**
 * 0.5.83 exit path: note credited to an Ed25519 recipient by a zk account spend. Fully
 * determined by public data (recipient, asset, amount, nullifier), so nobody can substitute
 * another output; it is spent like any other note, with the owner's spend-key signature.
 */
export function zkExitNote(recipientId: Fr, assetId: Fr, amount: bigint, nullifier: Fr): Note {
  return makeNote(recipientId, assetId, amount, hLeaf(encodeStringToFr(ZK_EXIT_NOTE_DOMAIN), nullifier));
}
