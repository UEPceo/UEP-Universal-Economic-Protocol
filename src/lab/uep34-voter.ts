/**
 * UEP-34.4 — Real voter lock (honest node cannot sign two incompatible proposals).
 *
 * LAB consensus safety; still NOT full partition-BFT finality.
 */

import fs from "node:fs";
import path from "node:path";
import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import {
  newLeaderBody,
  proposalDigest,
  type NewLeaderMsg,
} from "./uep34-election.ts";

export type LockedVote = {
  epoch: number;
  digest: string;
  proposal: Omit<NewLeaderMsg, "type" | "signature">;
};

export type QuorumVote = {
  nodeId: string;
  signature: string;
  /** Digest the voter locked to (for evidence). */
  digest: string;
  epoch: number;
};

export type DoubleVoteEvidence = {
  type: "double_vote_evidence";
  nodeId: string;
  epoch: number;
  voteA: QuorumVote;
  proposalA: Omit<NewLeaderMsg, "type" | "signature">;
  voteB: QuorumVote;
  proposalB: Omit<NewLeaderMsg, "type" | "signature">;
};

export type VoterDiskState = {
  version: 1;
  nodeId: string;
  networkId: string;
  domainId: number;
  locks: { epoch: number; digest: string; proposal: Omit<NewLeaderMsg, "type" | "signature"> }[];
};

/**
 * Stateful voter: one locked proposal digest per epoch.
 */
export class Voter {
  readonly identity: NodeIdentity;
  readonly networkId: string;
  readonly domainId: number;
  /** epoch → lock */
  private locks = new Map<number, LockedVote>();

  constructor(
    identity: NodeIdentity,
    networkId: string,
    domainId: number,
  ) {
    this.identity = identity;
    this.networkId = networkId;
    this.domainId = domainId;
  }

  getLock(epoch: number): LockedVote | undefined {
    return this.locks.get(epoch);
  }

  /**
   * Sign a vote only if unlocked or same digest. Different digest → refuse.
   */
  signVote(
    proposal: Omit<NewLeaderMsg, "type" | "signature">,
  ):
    | { ok: true; vote: QuorumVote }
    | { ok: false; reason: string } {
    if (proposal.networkId !== this.networkId) {
      return { ok: false, reason: "NETWORK_MISMATCH" };
    }
    if (proposal.domainId !== this.domainId) {
      return { ok: false, reason: "DOMAIN_MISMATCH" };
    }
    const digest = proposalDigest(proposal);
    const prev = this.locks.get(proposal.epoch);
    if (prev && prev.digest !== digest) {
      return { ok: false, reason: "ALREADY_LOCKED_OTHER_PROPOSAL" };
    }
    const signature = signBytes(this.identity, newLeaderBody(proposal));
    if (!prev) {
      this.locks.set(proposal.epoch, {
        epoch: proposal.epoch,
        digest,
        proposal: { ...proposal },
      });
    }
    return {
      ok: true,
      vote: {
        nodeId: this.identity.nodeId,
        signature,
        digest,
        epoch: proposal.epoch,
      },
    };
  }

  /** Persist locks for restart. */
  save(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const st: VoterDiskState = {
      version: 1,
      nodeId: this.identity.nodeId,
      networkId: this.networkId,
      domainId: this.domainId,
      locks: [...this.locks.values()].map((l) => ({
        epoch: l.epoch,
        digest: l.digest,
        proposal: l.proposal,
      })),
    };
    const file = path.join(dir, "voter-lock.json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, file);
  }

  load(dir: string): void {
    const file = path.join(dir, "voter-lock.json");
    if (!fs.existsSync(file)) return;
    const st = JSON.parse(fs.readFileSync(file, "utf8")) as VoterDiskState;
    if (st.nodeId !== this.identity.nodeId) {
      throw new Error("VOTER_LOCK_NODE_MISMATCH");
    }
    if (st.networkId !== this.networkId || st.domainId !== this.domainId) {
      throw new Error("VOTER_LOCK_NETWORK_MISMATCH");
    }
    this.locks.clear();
    for (const l of st.locks) {
      this.locks.set(l.epoch, {
        epoch: l.epoch,
        digest: l.digest,
        proposal: l.proposal,
      });
    }
  }
}

/**
 * Cryptographic double-vote evidence: two valid signatures, same voter, same epoch,
 * different digests.
 */
export function buildDoubleVoteEvidence(
  voteA: QuorumVote,
  proposalA: Omit<NewLeaderMsg, "type" | "signature">,
  voteB: QuorumVote,
  proposalB: Omit<NewLeaderMsg, "type" | "signature">,
): DoubleVoteEvidence | { error: string } {
  if (voteA.nodeId !== voteB.nodeId) return { error: "DIFFERENT_VOTERS" };
  if (voteA.epoch !== voteB.epoch) return { error: "DIFFERENT_EPOCHS" };
  if (voteA.digest === voteB.digest) return { error: "SAME_DIGEST" };
  return {
    type: "double_vote_evidence",
    nodeId: voteA.nodeId,
    epoch: voteA.epoch,
    voteA,
    proposalA,
    voteB,
    proposalB,
  };
}

export function verifyDoubleVoteEvidence(
  ev: DoubleVoteEvidence,
  publicKeyHex: string,
): { ok: true } | { ok: false; reason: string } {
  if (ev.voteA.nodeId !== ev.voteB.nodeId || ev.voteA.nodeId !== ev.nodeId) {
    return { ok: false, reason: "NODE_MISMATCH" };
  }
  if (ev.voteA.epoch !== ev.epoch || ev.voteB.epoch !== ev.epoch) {
    return { ok: false, reason: "EPOCH_MISMATCH" };
  }
  const dA = proposalDigest(ev.proposalA);
  const dB = proposalDigest(ev.proposalB);
  if (dA === dB) return { ok: false, reason: "SAME_PROPOSAL" };
  if (dA !== ev.voteA.digest || dB !== ev.voteB.digest) {
    return { ok: false, reason: "DIGEST_MISMATCH" };
  }
  if (!verifyBytes(publicKeyHex, newLeaderBody(ev.proposalA), ev.voteA.signature)) {
    return { ok: false, reason: "BAD_SIG_A" };
  }
  if (!verifyBytes(publicKeyHex, newLeaderBody(ev.proposalB), ev.voteB.signature)) {
    return { ok: false, reason: "BAD_SIG_B" };
  }
  return { ok: true };
}
