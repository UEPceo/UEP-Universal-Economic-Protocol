/**
 * UEP-35.7.1 — Authenticated consensus wire messages (LAB).
 * DATA plane stays on BATCH_*; these are CONSENSUS plane only.
 */

import { createHash } from "node:crypto";
import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import type { CommitCert } from "./uep34-commit-cert.ts";
import type { FinalityCertificate } from "./uep35-finality.ts";

export type ConsensusMsgType =
  | "PROPOSAL"
  | "VOTE"
  | "COMMIT_CERT"
  | "FINALITY_CERT";

export type ConsensusEnvelope = {
  type: ConsensusMsgType;
  sender: string;
  epoch: number;
  height: number;
  payloadDigest: string;
  /** JSON payload */
  payload: string;
  signature: string;
  msgId: string;
};

/** Digest covers the economic payload. Proof bytes are witness, not identity. */
export function consensusPayloadForDigest(payload: string): string {
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    delete obj.zkSpend;
    delete obj.proofHex;
    if (Array.isArray(obj.batch)) {
      obj.batch = obj.batch.map((item) => {
        if (!item || typeof item !== "object") return item;
        const copy = { ...(item as Record<string, unknown>) };
        delete copy.zkSpend;
        delete copy.proofHex;
        return copy;
      });
    }
    return JSON.stringify(obj);
  } catch {
    return payload;
  }
}

export function payloadDigest(payload: string): string {
  return createHash("sha256").update(consensusPayloadForDigest(payload)).digest("hex");
}

export function consensusSignBody(env: Omit<ConsensusEnvelope, "signature" | "msgId">): string {
  return [
    "UEP-35.7.1-CMSG",
    env.type,
    env.sender,
    String(env.epoch),
    String(env.height),
    env.payloadDigest,
  ].join("|");
}

export function sealConsensusMsg(
  identity: NodeIdentity,
  type: ConsensusMsgType,
  epoch: number,
  height: number,
  payloadObj: unknown,
): ConsensusEnvelope {
  const payload = JSON.stringify(payloadObj);
  const pd = payloadDigest(payload);
  const partial = {
    type,
    sender: identity.nodeId,
    epoch,
    height,
    payloadDigest: pd,
    payload,
  };
  const signature = signBytes(identity, consensusSignBody(partial));
  const msgId = createHash("sha256")
    .update(consensusSignBody(partial) + "|" + signature)
    .digest("hex")
    .slice(0, 24);
  return { ...partial, signature, msgId };
}

export function verifyConsensusMsg(
  env: ConsensusEnvelope,
  publicKeyHex: string,
): boolean {
  if (payloadDigest(env.payload) !== env.payloadDigest) return false;
  return verifyBytes(
    publicKeyHex,
    consensusSignBody({
      type: env.type,
      sender: env.sender,
      epoch: env.epoch,
      height: env.height,
      payloadDigest: env.payloadDigest,
      payload: env.payload,
    }),
    env.signature,
  );
}

/** Proposal payload (digest of batch+root — body stays DATA plane). */
export type ProposalPayload = {
  batchId: string;
  txDigest: string;
  stateRoot: string;
  /** ECON-05 full economic tip; when set, voters must match. */
  economicCommitment?: string;
  epoch: number;
  height: number;
  previousStateRoot: string;
  /** UEP-36.4: multi-batch aggregate proposal (optional) */
  aggregateDigest?: string;
  batchIds?: string[];
  entryDigests?: { batchId: string; txDigest: string }[];
  /** P4: serialized Groth16 artifact. Absent on 37.x economic-only proposals. */
  zkSpend?: string;
};

export type VotePayload = {
  proposalDigest: string;
  batchId: string;
  stateRoot: string;
};

export function proposalDigestFromPayload(p: ProposalPayload): string {
  if (p.aggregateDigest) {
    // FROZEN domain tag UEP-36.4-AGG-PROP (do not change).
    // batchIds sorted for set-equality of the same aggregate.
    const batchIdsCanon = [...(p.batchIds ?? [])].sort().join(",");
    return createHash("sha256")
      .update(
        [
          "UEP-36.4-AGG-PROP",
          String(p.epoch),
          String(p.height),
          p.aggregateDigest,
          p.stateRoot,
          p.previousStateRoot,
          batchIdsCanon,
          p.economicCommitment ?? "",
        ].join("|"),
      )
      .digest("hex");
  }
  const parts = [
    "UEP-35.7.1-PROP",
    String(p.epoch),
    String(p.height),
    p.batchId,
    p.txDigest,
    p.stateRoot,
    p.previousStateRoot,
    p.economicCommitment ?? "",
  ];
  if (p.zkSpend) {
    parts.push(createHash("sha256").update(p.zkSpend).digest("hex"));
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export type CommitCertPayload = {
  cert: CommitCert;
  batchId: string;
  stateRoot: string;
  epoch: number;
  height: number;
};

export type FinalityCertPayload = {
  cert: FinalityCertificate;
  batchId: string;
  stateRoot: string;
};
