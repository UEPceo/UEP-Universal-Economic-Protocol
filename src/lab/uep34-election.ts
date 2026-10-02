/**
 * UEP-34.0 / 34.3 — Lab sequencer election (NOT production BFT).
 *
 * Modes:
 * - LAB-SIMPLE-FAILOVER: acceptNewLeader with single claimer signature
 * - LAB-QUORUM-FAILOVER: only QuorumCert may advance epoch (see uep34-quorum)
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";

export type FailoverMode = "LAB-SIMPLE-FAILOVER" | "LAB-QUORUM-FAILOVER";

export type ElectionConfig = {
  networkId: string;
  domainId: number;
  candidates: string[];
  heartbeatTimeoutMs: number;
  /** Default LAB-SIMPLE; set QUORUM to forbid lone NewLeader acceptance. */
  mode?: FailoverMode;
};

export type LeaderState = {
  epoch: number;
  leaderNodeId: string;
  lastSequence: number;
  lastStateRoot: string;
  lastNullifierRoot: string;
};

/** Canonical checkpoint bound into NewLeader / QC. */
export type StateCheckpoint = {
  epoch: number;
  sequence: number;
  stateRoot: string;
  nullifierRoot: string;
};

export type NewLeaderMsg = {
  type: "new_leader";
  networkId: string;
  domainId: number;
  epoch: number;
  leaderNodeId: string;
  prevEpoch: number;
  continueFromRoot: string;
  continueFromSequence: number;
  continueFromNullifierRoot?: string;
  ts: number;
  signature: string;
};

export function newLeaderBody(m: Omit<NewLeaderMsg, "type" | "signature">): string {
  return [
    "UEP-34-NL",
    m.networkId,
    String(m.domainId),
    String(m.epoch),
    m.leaderNodeId,
    String(m.prevEpoch),
    m.continueFromRoot,
    String(m.continueFromSequence),
    m.continueFromNullifierRoot ?? "",
    String(m.ts),
  ].join("|");
}

export function proposalDigest(m: Omit<NewLeaderMsg, "type" | "signature">): string {
  // Stable hash-like id without crypto dep: body itself is unique enough for lab maps
  return newLeaderBody(m);
}

export function signNewLeader(
  identity: NodeIdentity,
  partial: Omit<NewLeaderMsg, "type" | "signature" | "leaderNodeId">,
): NewLeaderMsg {
  const msg: Omit<NewLeaderMsg, "signature"> = {
    type: "new_leader",
    ...partial,
    leaderNodeId: identity.nodeId,
  };
  return {
    ...msg,
    signature: signBytes(identity, newLeaderBody(msg)),
  };
}

export function verifyNewLeader(
  msg: NewLeaderMsg,
  leaderPublicKeyHex: string,
  cfg: ElectionConfig,
): { ok: true } | { ok: false; reason: string } {
  if (msg.networkId !== cfg.networkId) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (msg.domainId !== cfg.domainId) return { ok: false, reason: "DOMAIN_MISMATCH" };
  if (!cfg.candidates.includes(msg.leaderNodeId)) {
    return { ok: false, reason: "NOT_A_CANDIDATE" };
  }
  if (!verifyBytes(leaderPublicKeyHex, newLeaderBody(msg), msg.signature)) {
    return { ok: false, reason: "BAD_NEW_LEADER_SIGNATURE" };
  }
  return { ok: true };
}

export function nextCandidate(
  candidates: string[],
  currentLeaderId: string,
): string {
  if (candidates.length === 0) throw new Error("NO_CANDIDATES");
  const i = candidates.indexOf(currentLeaderId);
  const idx = i < 0 ? 0 : (i + 1) % candidates.length;
  return candidates[idx]!;
}

export function leaderForEpoch(candidates: string[], epoch: number): string {
  if (candidates.length === 0) throw new Error("NO_CANDIDATES");
  return candidates[epoch % candidates.length]!;
}

export class SequencerElection {
  readonly cfg: ElectionConfig;
  state: LeaderState;
  /**
   * Local vote lock: epoch → proposal digest this node has voted for.
   * Used by quorum layer for one-vote-per-epoch.
   */
  votedEpoch = new Map<number, string>();
  /** Equivocation evidence: nodeId → list of digests seen for same epoch. */
  equivocations: { nodeId: string; epoch: number; digests: string[] }[] = [];
  /**
   * Leader proposal lock at current epoch tip: sequence → digest of envelope
   * (prevents two different newStateRoots at same sequence from same leader).
   */
  leaderProposalAtSeq = new Map<string, string>(); // key: `${epoch}:${seq}` → root

  constructor(cfg: ElectionConfig, genesisRoot = "GENESIS") {
    if (cfg.candidates.length < 1) throw new Error("NEED_CANDIDATES");
    this.cfg = { ...cfg, mode: cfg.mode ?? "LAB-SIMPLE-FAILOVER" };
    this.state = {
      epoch: 0,
      leaderNodeId: cfg.candidates[0]!,
      lastSequence: 0,
      lastStateRoot: genesisRoot,
      lastNullifierRoot: "GENESIS_NF",
    };
  }

  isLeader(nodeId: string): boolean {
    return this.state.leaderNodeId === nodeId;
  }

  mode(): FailoverMode {
    return this.cfg.mode ?? "LAB-SIMPLE-FAILOVER";
  }

  checkpoint(): StateCheckpoint {
    return {
      epoch: this.state.epoch,
      sequence: this.state.lastSequence,
      stateRoot: this.state.lastStateRoot,
      nullifierRoot: this.state.lastNullifierRoot,
    };
  }

  /**
   * Record a vote intent. Returns EQUIVOCATION if already voted different proposal.
   */
  recordVote(
    voterId: string,
    epoch: number,
    digest: string,
  ): { ok: true } | { ok: false; reason: string } {
    const prev = this.votedEpoch.get(epoch);
    if (prev !== undefined && prev !== digest) {
      this.equivocations.push({
        nodeId: voterId,
        epoch,
        digests: [prev, digest],
      });
      return { ok: false, reason: "EQUIVOCATION" };
    }
    this.votedEpoch.set(epoch, digest);
    return { ok: true };
  }

  /**
   * Detect leader equivocation: two different newStateRoots at same epoch+sequence.
   */
  noteLeaderProposal(
    epoch: number,
    sequence: number,
    newStateRoot: string,
  ): { ok: true } | { ok: false; reason: string } {
    const key = `${epoch}:${sequence}`;
    const prev = this.leaderProposalAtSeq.get(key);
    if (prev !== undefined && prev !== newStateRoot) {
      this.equivocations.push({
        nodeId: this.state.leaderNodeId,
        epoch,
        digests: [prev, newStateRoot],
      });
      return { ok: false, reason: "LEADER_EQUIVOCATION" };
    }
    this.leaderProposalAtSeq.set(key, newStateRoot);
    return { ok: true };
  }

  acceptNewLeader(
    msg: NewLeaderMsg,
    leaderPublicKeyHex: string,
  ): { ok: true } | { ok: false; reason: string } {
    if (this.mode() === "LAB-QUORUM-FAILOVER") {
      return { ok: false, reason: "QUORUM_REQUIRED" };
    }
    return this.applyNewLeader(msg, leaderPublicKeyHex);
  }

  /** Shared apply used by simple accept and after QC verification. */
  applyNewLeader(
    msg: NewLeaderMsg,
    leaderPublicKeyHex: string,
  ): { ok: true } | { ok: false; reason: string } {
    const v = verifyNewLeader(msg, leaderPublicKeyHex, this.cfg);
    if (!v.ok) return v;
    if (msg.epoch !== this.state.epoch + 1) {
      return { ok: false, reason: "EPOCH_GAP" };
    }
    if (msg.prevEpoch !== this.state.epoch) {
      return { ok: false, reason: "PREV_EPOCH_MISMATCH" };
    }
    const expected = nextCandidate(this.cfg.candidates, this.state.leaderNodeId);
    if (msg.leaderNodeId !== expected) {
      return { ok: false, reason: "UNEXPECTED_LEADER" };
    }
    if (msg.continueFromSequence !== this.state.lastSequence) {
      return { ok: false, reason: "CHECKPOINT_SEQUENCE_MISMATCH" };
    }
    if (
      this.state.lastSequence > 0 &&
      msg.continueFromRoot !== this.state.lastStateRoot
    ) {
      return { ok: false, reason: "CONTINUE_ROOT_MISMATCH" };
    }
    if (
      msg.continueFromNullifierRoot !== undefined &&
      this.state.lastSequence > 0 &&
      msg.continueFromNullifierRoot !== this.state.lastNullifierRoot
    ) {
      return { ok: false, reason: "CONTINUE_NF_ROOT_MISMATCH" };
    }
    this.state = {
      epoch: msg.epoch,
      leaderNodeId: msg.leaderNodeId,
      lastSequence: msg.continueFromSequence,
      lastStateRoot: msg.continueFromRoot,
      lastNullifierRoot:
        msg.continueFromNullifierRoot ?? this.state.lastNullifierRoot,
    };
    return { ok: true };
  }

  claimLeadership(
    identity: NodeIdentity,
    continueFromRoot: string,
    continueFromSequence: number,
    continueFromNullifierRoot?: string,
  ): NewLeaderMsg | { error: string } {
    const expected = nextCandidate(this.cfg.candidates, this.state.leaderNodeId);
    if (identity.nodeId !== expected) {
      return { error: "NOT_NEXT_CANDIDATE" };
    }
    return signNewLeader(identity, {
      networkId: this.cfg.networkId,
      domainId: this.cfg.domainId,
      epoch: this.state.epoch + 1,
      prevEpoch: this.state.epoch,
      continueFromRoot,
      continueFromSequence,
      continueFromNullifierRoot,
      ts: Date.now(),
    });
  }

  noteCommit(
    sequence: number,
    stateRoot: string,
    nullifierRoot?: string,
  ): void {
    this.state.lastSequence = sequence;
    this.state.lastStateRoot = stateRoot;
    if (nullifierRoot !== undefined) this.state.lastNullifierRoot = nullifierRoot;
  }
}
