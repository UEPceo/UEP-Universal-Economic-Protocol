/**
 * UEP-34.5 — Proposal dissemination + commit certificates (lab).
 *
 * Closes experimental-room E4/E9 class issues:
 * - Same (leader, sequence) cannot bind two different roots once registered.
 * - Apply requires a CommitCert with ≥ quorum signatures over proposal digest.
 * - Votes on NewLeader are registered in a shared VoteBoard (lab gossip).
 *
 * LAB / NOT full async BFT under arbitrary partitions without the shared board.
 * With the board (single process / future gossip), equivocation is detectable
 * and conflicting commits are rejected.
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import type { NodeEnvelope } from "./node-protocol.ts";
import { envelopeBody } from "./node-protocol.ts";
import { majorityThreshold } from "./uep34-bft-params.ts";
import { assertBftConfig, type BftProfile } from "./uep35-bft-gate.ts";
import {
  newLeaderBody,
  proposalDigest,
  type NewLeaderMsg,
} from "./uep34-election.ts";
import type { QuorumVote } from "./uep34-voter.ts";

/**
 * Canonical proposal identity = full signed envelope body (all fields in envelopeBody).
 * Prefix distinguishes commit-vote domain from Ed25519 envelope signature domain.
 */
export function envelopeProposalDigest(env: Omit<NodeEnvelope, "signature">): string {
  return `UEP-34.5-PROP|${envelopeBody(env)}`;
}

export type TransitionProposal = {
  digest: string;
  networkId: string;
  domainId: number;
  leaderNodeId: string;
  sequence: number;
  previousStateRoot: string;
  newStateRoot: string;
  nullifier: string;
  transitionId: string;
};

export function proposalFromEnvelope(env: NodeEnvelope): TransitionProposal {
  const body = { ...env };
  return {
    digest: envelopeProposalDigest(body),
    networkId: env.networkId,
    domainId: env.domainId,
    leaderNodeId: env.nodeId,
    sequence: env.sequence,
    previousStateRoot: env.previousStateRoot,
    newStateRoot: env.newStateRoot,
    nullifier: env.nullifier,
    transitionId: env.transitionId,
  };
}

export type CommitVote = {
  nodeId: string;
  proposalDigest: string;
  signature: string;
};

export type CommitCert = {
  proposal: TransitionProposal;
  votes: CommitVote[];
};

export function commitVoteBody(digest: string): string {
  return `UEP-34.5-COMMIT|${digest}`;
}

export function signCommitVote(
  identity: NodeIdentity,
  proposalDigest: string,
): CommitVote {
  return {
    nodeId: identity.nodeId,
    proposalDigest,
    signature: signBytes(identity, commitVoteBody(proposalDigest)),
  };
}

export function verifyCommitVote(
  vote: CommitVote,
  publicKeyHex: string,
): boolean {
  return verifyBytes(
    publicKeyHex,
    commitVoteBody(vote.proposalDigest),
    vote.signature,
  );
}

/**
 * Shared lab registry: first proposal for (leader, seq) wins; second different
 * digest → EQUIVOCATION evidence, neither can gain a commit cert thereafter.
 */
export class ProposalBoard {
  /** key = `${leaderId}:${sequence}` → first registered digest */
  private bySeq = new Map<string, string>();
  /** digest → proposal */
  private proposals = new Map<string, TransitionProposal>();
  /** digests marked bad due to equivocation */
  private poisoned = new Set<string>();
  equivocations: { leaderId: string; sequence: number; digests: string[] }[] = [];

  register(p: TransitionProposal): { ok: true } | { ok: false; reason: string } {
    const key = `${p.leaderNodeId}:${p.sequence}`;
    const existing = this.bySeq.get(key);
    if (existing !== undefined && existing !== p.digest) {
      this.poisoned.add(existing);
      this.poisoned.add(p.digest);
      this.equivocations.push({
        leaderId: p.leaderNodeId,
        sequence: p.sequence,
        digests: [existing, p.digest],
      });
      return { ok: false, reason: "LEADER_EQUIVOCATION" };
    }
    if (this.poisoned.has(p.digest)) {
      return { ok: false, reason: "POISONED_PROPOSAL" };
    }
    this.bySeq.set(key, p.digest);
    this.proposals.set(p.digest, p);
    return { ok: true };
  }

  get(digest: string): TransitionProposal | undefined {
    return this.proposals.get(digest);
  }

  isPoisoned(digest: string): boolean {
    return this.poisoned.has(digest);
  }
}

/**
 * Shared vote board for NewLeader QCs — first digest per (voter, epoch) locked.
 */
export class VoteBoard {
  private locks = new Map<string, string>(); // `${voterId}:${epoch}` → digest

  register(
    voterId: string,
    epoch: number,
    digest: string,
  ): { ok: true } | { ok: false; reason: string } {
    const key = `${voterId}:${epoch}`;
    const prev = this.locks.get(key);
    if (prev !== undefined && prev !== digest) {
      return { ok: false, reason: "VOTE_EQUIVOCATION" };
    }
    this.locks.set(key, digest);
    return { ok: true };
  }

  get(voterId: string, epoch: number): string | undefined {
    return this.locks.get(`${voterId}:${epoch}`);
  }
}

export function assembleCommitCert(
  proposal: TransitionProposal,
  votes: CommitVote[],
): CommitCert {
  return { proposal, votes };
}

export function verifyCommitCert(
  cert: CommitCert,
  candidates: string[],
  publicKeyOf: (nodeId: string) => string | undefined,
  board?: ProposalBoard,
  opts?: { bftProfile?: BftProfile },
): { ok: true } | { ok: false; reason: string } {
  if (board?.isPoisoned(cert.proposal.digest)) {
    return { ok: false, reason: "POISONED_PROPOSAL" };
  }
  if (board) {
    const reg = board.register(cert.proposal);
    // already registered same digest is ok; equivocation fails
    if (!reg.ok && reg.reason === "LEADER_EQUIVOCATION") {
      return { ok: false, reason: reg.reason };
    }
  }
  const profile = opts?.bftProfile ?? "LAB-MAJORITY";
  const gate = assertBftConfig(candidates.length, profile);
  if (!gate.ok) {
    return { ok: false, reason: `BFT_CONFIG:${gate.reason}` };
  }
  const need = gate.params.quorum;
  const seen = new Set<string>();
  let valid = 0;
  for (const v of cert.votes) {
    if (v.proposalDigest !== cert.proposal.digest) continue;
    if (!candidates.includes(v.nodeId)) continue;
    if (seen.has(v.nodeId)) continue;
    const pk = publicKeyOf(v.nodeId);
    if (!pk || !verifyCommitVote(v, pk)) continue;
    seen.add(v.nodeId);
    valid++;
  }
  if (valid < need) {
    return { ok: false, reason: `COMMIT_QUORUM_NOT_MET:${valid}/${need}` };
  }
  return { ok: true };
}

/**
 * Register QC votes on shared VoteBoard; reject if any voter already locked elsewhere.
 */
export function disseminateQcVotes(
  board: VoteBoard,
  epoch: number,
  digest: string,
  votes: QuorumVote[],
): { ok: true } | { ok: false; reason: string; nodeId?: string } {
  for (const v of votes) {
    const r = board.register(v.nodeId, epoch, digest);
    if (!r.ok) return { ok: false, reason: r.reason, nodeId: v.nodeId };
  }
  return { ok: true };
}

/** Body helper for NewLeader digest (same as election proposalDigest). */
export function newLeaderDigest(
  p: Omit<NewLeaderMsg, "type" | "signature">,
): string {
  return proposalDigest(p);
}
