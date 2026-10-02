/**
 * UEP-34.2–34.4 — Quorum certificates with BFT threshold + local continuity.
 * LAB / NOT production finality.
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import {
  newLeaderBody,
  proposalDigest,
  type NewLeaderMsg,
  type ElectionConfig,
  type SequencerElection,
} from "./uep34-election.ts";
import { majorityThreshold, bftParamsFromN } from "./uep34-bft-params.ts";
import {
  Voter,
  type QuorumVote,
  type DoubleVoteEvidence,
  buildDoubleVoteEvidence,
  verifyDoubleVoteEvidence,
} from "./uep34-voter.ts";

export type { QuorumVote, DoubleVoteEvidence };
export { Voter, buildDoubleVoteEvidence, verifyDoubleVoteEvidence, majorityThreshold, bftParamsFromN };

export type QuorumCert = {
  proposal: Omit<NewLeaderMsg, "signature"> & { signature?: string };
  votes: QuorumVote[];
};

export type QcLocalState = {
  currentEpoch: number;
  currentLeaderId: string;
  lastSequence: number;
  lastStateRoot: string;
  lastNullifierRoot?: string;
  voteLog: Map<string, Map<number, string>>;
  /** Require exact sequence match (no jump without catch-up cert). */
  requireExactSequence?: boolean;
};

export function voteBody(proposal: Omit<NewLeaderMsg, "type" | "signature">): string {
  return newLeaderBody(proposal);
}

/** Legacy free sign — prefer Voter.signVote for honest nodes. */
export function signVoteLegacy(
  identity: NodeIdentity,
  proposal: Omit<NewLeaderMsg, "type" | "signature">,
): QuorumVote {
  const digest = proposalDigest(proposal);
  return {
    nodeId: identity.nodeId,
    signature: signBytes(identity, newLeaderBody(proposal)),
    digest,
    epoch: proposal.epoch,
  };
}

export function verifyVote(
  vote: QuorumVote,
  proposal: Omit<NewLeaderMsg, "type" | "signature">,
  publicKeyHex: string,
  candidates: string[],
): { ok: true } | { ok: false; reason: string } {
  if (!candidates.includes(vote.nodeId)) {
    return { ok: false, reason: "NOT_A_CANDIDATE" };
  }
  const digest = proposalDigest(proposal);
  if (vote.digest && vote.digest !== digest) {
    return { ok: false, reason: "VOTE_DIGEST_MISMATCH" };
  }
  if (vote.epoch !== undefined && vote.epoch !== proposal.epoch) {
    return { ok: false, reason: "VOTE_EPOCH_MISMATCH" };
  }
  if (!verifyBytes(publicKeyHex, newLeaderBody(proposal), vote.signature)) {
    return { ok: false, reason: "BAD_VOTE_SIGNATURE" };
  }
  return { ok: true };
}

export function assembleQuorumCert(
  proposal: NewLeaderMsg,
  votes: QuorumVote[],
): QuorumCert {
  return {
    proposal: {
      type: "new_leader",
      networkId: proposal.networkId,
      domainId: proposal.domainId,
      epoch: proposal.epoch,
      leaderNodeId: proposal.leaderNodeId,
      prevEpoch: proposal.prevEpoch,
      continueFromRoot: proposal.continueFromRoot,
      continueFromSequence: proposal.continueFromSequence,
      continueFromNullifierRoot: proposal.continueFromNullifierRoot,
      ts: proposal.ts,
      signature: proposal.signature,
    },
    votes,
  };
}

export function recordVotesInLog(
  log: Map<string, Map<number, string>>,
  epoch: number,
  digest: string,
  votes: QuorumVote[],
): { ok: true } | { ok: false; reason: string; equivocating?: string } {
  for (const v of votes) {
    let byEpoch = log.get(v.nodeId);
    if (!byEpoch) {
      byEpoch = new Map();
      log.set(v.nodeId, byEpoch);
    }
    const prev = byEpoch.get(epoch);
    if (prev !== undefined && prev !== digest) {
      return { ok: false, reason: "EQUIVOCATION", equivocating: v.nodeId };
    }
    byEpoch.set(epoch, digest);
  }
  return { ok: true };
}

export type VerifyQcOpts = {
  local?: QcLocalState;
  requireNextEpoch?: boolean;
};

export function verifyQuorumCert(
  cert: QuorumCert,
  cfg: ElectionConfig,
  publicKeyOf: (nodeId: string) => string | undefined,
  opts?: VerifyQcOpts,
): { ok: true } | { ok: false; reason: string } {
  const p = cert.proposal;
  if (p.networkId !== cfg.networkId) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (p.domainId !== cfg.domainId) return { ok: false, reason: "DOMAIN_MISMATCH" };
  if (!cfg.candidates.includes(p.leaderNodeId)) {
    return { ok: false, reason: "NOT_A_CANDIDATE" };
  }

  const local = opts?.local;
  if (local) {
    const requireNext = opts?.requireNextEpoch !== false;
    if (requireNext && p.epoch !== local.currentEpoch + 1) {
      return { ok: false, reason: "EPOCH_NOT_NEXT" };
    }
    if (p.prevEpoch !== local.currentEpoch) {
      return { ok: false, reason: "PREV_EPOCH_MISMATCH" };
    }
    const exact = local.requireExactSequence !== false;
    if (exact) {
      if (p.continueFromSequence !== local.lastSequence) {
        return { ok: false, reason: "CHECKPOINT_SEQUENCE_MISMATCH" };
      }
    } else if (p.continueFromSequence < local.lastSequence) {
      return { ok: false, reason: "SEQUENCE_REGRESSION" };
    }
    if (
      local.lastSequence > 0 &&
      p.continueFromRoot !== local.lastStateRoot
    ) {
      return { ok: false, reason: "CONTINUE_ROOT_MISMATCH" };
    }
  }

  const digest = proposalDigest({
    networkId: p.networkId,
    domainId: p.domainId,
    epoch: p.epoch,
    leaderNodeId: p.leaderNodeId,
    prevEpoch: p.prevEpoch,
    continueFromRoot: p.continueFromRoot,
    continueFromSequence: p.continueFromSequence,
    continueFromNullifierRoot: p.continueFromNullifierRoot,
    ts: p.ts,
  });

  const need = majorityThreshold(cfg.candidates.length);
  const seen = new Set<string>();
  let valid = 0;
  for (const v of cert.votes) {
    if (seen.has(v.nodeId)) continue;
    const pk = publicKeyOf(v.nodeId);
    if (!pk) continue;
    const r = verifyVote(
      v,
      {
        networkId: p.networkId,
        domainId: p.domainId,
        epoch: p.epoch,
        leaderNodeId: p.leaderNodeId,
        prevEpoch: p.prevEpoch,
        continueFromRoot: p.continueFromRoot,
        continueFromSequence: p.continueFromSequence,
        continueFromNullifierRoot: p.continueFromNullifierRoot,
        ts: p.ts,
      },
      pk,
      cfg.candidates,
    );
    if (!r.ok) continue;
    seen.add(v.nodeId);
    valid++;
  }
  if (valid < need) {
    return { ok: false, reason: `QUORUM_NOT_MET:${valid}/${need}` };
  }

  if (local?.voteLog) {
    const lock = recordVotesInLog(local.voteLog, p.epoch, digest, cert.votes);
    if (!lock.ok) {
      return { ok: false, reason: `VOTE_EQUIVOCATION:${lock.equivocating}` };
    }
  }

  return { ok: true };
}

/** Collect votes via stateful Voters (honest path cannot double-sign). */
export function collectVotesFromVoters(
  voters: Voter[],
  proposal: Omit<NewLeaderMsg, "type" | "signature">,
):
  | { ok: true; votes: QuorumVote[] }
  | { ok: false; reason: string; failedNode?: string } {
  const votes: QuorumVote[] = [];
  for (const v of voters) {
    const r = v.signVote(proposal);
    if (!r.ok) {
      return { ok: false, reason: r.reason, failedNode: v.identity.nodeId };
    }
    votes.push(r.vote);
  }
  return { ok: true, votes };
}

/** @deprecated use collectVotesFromVoters */
export function collectVotes(
  voters: NodeIdentity[],
  proposal: Omit<NewLeaderMsg, "type" | "signature">,
): QuorumVote[] {
  // Temporary: creates ephemeral voters (locks discarded) — tests should use Voter
  const out: QuorumVote[] = [];
  for (const id of voters) {
    const v = new Voter(id, proposal.networkId, proposal.domainId);
    const r = v.signVote(proposal);
    if (!r.ok) throw new Error(r.reason);
    out.push(r.vote);
  }
  return out;
}

export function localFromElection(
  el: SequencerElection,
  voteLog?: Map<string, Map<number, string>>,
): QcLocalState {
  return {
    currentEpoch: el.state.epoch,
    currentLeaderId: el.state.leaderNodeId,
    lastSequence: el.state.lastSequence,
    lastStateRoot: el.state.lastStateRoot,
    lastNullifierRoot: el.state.lastNullifierRoot,
    voteLog: voteLog ?? new Map(),
    requireExactSequence: true,
  };
}

export function signVote(
  identity: NodeIdentity,
  proposal: Omit<NewLeaderMsg, "type" | "signature">,
): QuorumVote {
  return signVoteLegacy(identity, proposal);
}
