/**
 * UEP-38.35 — apply guards.
 * VK pin rejects another setup seed. Sender auth rejects a leader spending
 * an account they do not hold. Nullifiers live in the economic state.
 *
 * This is a ceremony rehearsal, not a ceremony. The trapdoor stays in the proving key.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { signBytes, verifyBytes, type NodeIdentity } from "./node-identity.ts";
import type { SpendProofArtifact } from "./uep38-zk-state-transition.ts";
import { LAB_PROFILE } from "./uep-network-profile.ts";

export const CEREMONY_STATUS = "REHEARSAL_ONLY_TRAPDOOR_RETAINED";

export function senderAuthBody(input: {
  domainId: string;
  senderId: string;
  recipientId: string;
  amount: string;
  fee: string;
  nullifier: string;
  oldRoot: string;
}): string {
  return [
    "UEP-38.35-SENDER-AUTH",
    input.domainId,
    input.senderId,
    input.recipientId,
    input.amount,
    input.fee,
    input.nullifier,
    input.oldRoot,
  ].join("|");
}

export function senderIdentityFromSecret(secretHex: string): NodeIdentity {
  const seed = createHash("sha256").update(`UEP-SENDER-AUTH|${secretHex}`).digest();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  return {
    nodeId: "sender",
    privateKey,
    publicKey,
    publicKeyHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
  };
}

export function signSenderAuth(secretHex: string, body: string): { publicKeyHex: string; signature: string } {
  const id = senderIdentityFromSecret(secretHex);
  return { publicKeyHex: id.publicKeyHex, signature: signBytes(id, body) };
}

export function verifySenderAuth(publicKeyHex: string, body: string, signature: string): boolean {
  return verifyBytes(publicKeyHex, body, signature);
}

export function vkId(vkHex: string): string {
  return createHash("sha256").update(vkHex.replace(/^0x/i, "").toLowerCase()).digest("hex");
}

export function assertPinnedVk(art: SpendProofArtifact, pinnedVkHex: string): { ok: boolean; reason?: string } {
  const got = art.vkHex.replace(/^0x/i, "").toLowerCase();
  const want = pinnedVkHex.replace(/^0x/i, "").toLowerCase();
  if (!got || got !== want) return { ok: false, reason: "VK_NOT_PINNED" };
  return { ok: true };
}

export function labAuthBodyFromArtifact(art: SpendProofArtifact): string {
  return senderAuthBody({
    domainId: LAB_PROFILE.domainId,
    senderId: art.publicInputsHex[4] ?? "",
    recipientId: art.publicInputsHex[5] ?? "",
    amount: art.publicInputsHex[8] ?? "",
    fee: art.publicInputsHex[9] ?? "",
    nullifier: art.publicInputsHex[10] ?? "",
    oldRoot: art.publicInputsHex[0] ?? "",
  });
}

export type SenderAuth = { publicKeyHex: string; signature: string; body: string };
