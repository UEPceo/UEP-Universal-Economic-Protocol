/**
 * UEP-38.31 — spend quorum signs the economic statement, never the proof.
 * A Groth16 proof can be re-randomized without changing what it proves.
 * The proof is verified separately. It is not part of spendId or the vote.
 */
import { createPrivateKey } from "node:crypto";
import { signBytes, verifyBytes, type NodeIdentity } from "./node-identity.ts";

export const P4_SPEND_CERT_NEED = 3;
/** BN254 scalar field modulus. A public input >= r is an alias, not a canonical element. */
export const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type SpendStatement = {
  domainId: string;
  spendId: string;
  oldRoot: string;
  newRoot: string;
  nullifier: string;
  amount: string;
  fee: string;
  senderId: string;
  recipientId: string;
  treasuryId: string;
  assetId: string;
};

export type P4SpendCert = SpendStatement & {
  votes: { nodeId: string; signature: string }[];
};

export function canonicalFieldHex(hex: string): { ok: boolean; reason?: string; hex?: string } {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(h)) return { ok: false, reason: "PUBLIC_NOT_CANONICAL" };
  if (BigInt("0x" + h) >= BN254_FR) return { ok: false, reason: "PUBLIC_FIELD_ALIAS" };
  return { ok: true, hex: h.padStart(64, "0") };
}

export function p4SpendVoteBody(s: SpendStatement): string {
  return [
    "UEP-38.31-SPEND-STMT",
    s.domainId,
    s.spendId,
    s.oldRoot,
    s.newRoot,
    s.nullifier,
    s.amount,
    s.fee,
    s.senderId,
    s.recipientId,
    s.treasuryId,
    s.assetId,
  ].join("|");
}

export function signP4Spend(identity: NodeIdentity, statement: SpendStatement): { nodeId: string; signature: string } {
  return { nodeId: identity.nodeId, signature: signBytes(identity, p4SpendVoteBody(statement)) };
}

export function verifyP4SpendCert(
  pubkeys: Map<string, string>,
  cert: P4SpendCert,
): { ok: boolean; reason?: string } {
  if (!cert?.spendId || !cert.newRoot || !cert.nullifier) return { ok: false, reason: "SPEND_CERT_REQUIRED" };
  for (const field of [cert.oldRoot, cert.newRoot, cert.nullifier]) {
    const c = canonicalFieldHex(field);
    if (!c.ok) return c;
  }
  const body = p4SpendVoteBody(cert);
  const seen = new Set<string>();
  let good = 0;
  for (const v of cert.votes ?? []) {
    if (seen.has(v.nodeId)) continue;
    const pk = pubkeys.get(v.nodeId);
    if (!pk) continue;
    if (!verifyBytes(pk, body, v.signature)) continue;
    seen.add(v.nodeId);
    good++;
  }
  if (good < P4_SPEND_CERT_NEED) return { ok: false, reason: `SPEND_CERT_QUORUM:${good}` };
  return { ok: true };
}

export function identityFromBoot(nodeId: string, privateKeyHex: string, publicKeyHex: string): NodeIdentity {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyHex, "hex"), type: "pkcs8", format: "der" });
  return { nodeId, privateKey, publicKey: privateKey, publicKeyHex };
}
