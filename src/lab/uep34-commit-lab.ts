/**
 * UEP-34.5 — Cluster lab that requires CommitCert before applying envelopes,
 * and VoteBoard before accepting QCs (closes E4/E9 in shared-lab model).
 */

import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
  type NodeIdentity,
} from "./node-identity.ts";
import { LabNode } from "./node-protocol.ts";
import {
  SequencerElection,
  nextCandidate,
  type FailoverMode,
  type ElectionConfig,
  type NewLeaderMsg,
} from "./uep34-election.ts";
import {
  ProposalBoard,
  VoteBoard,
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
  verifyCommitCert,
  disseminateQcVotes,
  newLeaderDigest,
  type CommitCert,
} from "./uep34-commit-cert.ts";
import {
  Voter,
  collectVotesFromVoters,
  assembleQuorumCert,
  verifyQuorumCert,
  localFromElection,
  type QuorumCert,
} from "./uep34-quorum.ts";

export type CommitLabNode = {
  id: NodeIdentity;
  lab: LabNode;
  election: SequencerElection;
  voter: Voter;
};

export type CommitLab = {
  nodes: CommitLabNode[];
  registry: NodeRegistry;
  proposalBoard: ProposalBoard;
  voteBoard: VoteBoard;
  cfg: ElectionConfig;
  leaderId: () => string;
  /**
   * Leader proposes + cluster builds CommitCert + all apply.
   * Conflicting second root at same seq → EQUIVOCATION, no apply.
   */
  commitTransition: (input: {
    newStateRoot: string;
    transitionId: string;
    nullifier: string;
  }) => { ok: true; sequence: number; cert: CommitCert } | { ok: false; error: string };
  failoverWithQuorum: () => {
    ok: boolean;
    newLeader: string;
    epoch: number;
    error?: string;
  };
};

export function bootCommitLab(opts?: {
  n?: number;
  networkId?: string;
  domainId?: number;
}): CommitLab {
  const n = opts?.n ?? 4;
  const networkId = opts?.networkId ?? "local";
  const domainId = opts?.domainId ?? 1;
  const mode: FailoverMode = "LAB-QUORUM-FAILOVER";

  const ids: NodeIdentity[] = [];
  for (let i = 0; i < n; i++) ids.push(createNodeIdentity(`c${i}`));
  const candidates = ids.map((x) => x.nodeId);

  const registry = new NodeRegistry();
  for (const id of ids) {
    registry.register(
      registryFromIdentity(id, {
        networkId,
        domainId,
        role: "sequencer",
      }),
    );
  }

  const cfg: ElectionConfig = {
    networkId,
    domainId,
    candidates,
    heartbeatTimeoutMs: 500,
    mode,
  };

  const proposalBoard = new ProposalBoard();
  const voteBoard = new VoteBoard();
  const voteLog = new Map<string, Map<number, string>>();

  const nodes: CommitLabNode[] = ids.map((id) => {
    const election = new SequencerElection(cfg, "GENESIS");
    const lab = new LabNode(
      id,
      networkId,
      domainId,
      ids[0]!.publicKeyHex,
      ids[0]!.nodeId,
      {
        requireCommitCert: true,
        commitCandidates: candidates,
        commitPublicKeyOf: (nid) => registry.publicKeyHex(nid),
        proposalBoard,
      },
    );
    const voter = new Voter(id, networkId, domainId);
    return { id, lab, election, voter };
  });

  const leaderId = () => nodes[0]!.election.state.leaderNodeId;

  function leaderNode(): CommitLabNode {
    const lid = leaderId();
    const found = nodes.find((x) => x.id.nodeId === lid);
    if (!found) throw new Error("LEADER_MISSING");
    return found;
  }

  const api: CommitLab = {
    nodes,
    registry,
    proposalBoard,
    voteBoard,
    cfg,
    leaderId,
    commitTransition(input) {
      const leader = leaderNode();
      try {
        const env = leader.lab.propose({
          previousStateRoot: leader.lab.stateRoot,
          newStateRoot: input.newStateRoot,
          transitionId: input.transitionId,
          nullifier: input.nullifier,
        });
        const prop = proposalFromEnvelope(env);
        const reg = proposalBoard.register(prop);
        if (!reg.ok) return { ok: false, error: reg.reason };

        // All candidates vote commit
        const votes = nodes.map((n) =>
          signCommitVote(n.id, prop.digest),
        );
        const cert = assembleCommitCert(prop, votes);
        const vr = verifyCommitCert(
          cert,
          candidates,
          (id) => registry.publicKeyHex(id),
          proposalBoard,
        );
        if (!vr.ok) return { ok: false, error: vr.reason };

        for (const n of nodes) {
          n.lab.sequencerPublicKeyHex = leader.id.publicKeyHex;
          n.lab.sequencerNodeId = leader.id.nodeId;
          // Equivocation lock on election side
          const eq = n.election.noteLeaderProposal(
            n.election.state.epoch,
            env.sequence,
            env.newStateRoot,
          );
          if (!eq.ok) return { ok: false, error: eq.reason };
          const r = n.lab.apply(env, { commitCert: cert });
          if (!r.ok) return { ok: false, error: `${n.id.nodeId}:${r.error}` };
          n.election.noteCommit(env.sequence, env.newStateRoot);
        }
        return { ok: true, sequence: env.sequence, cert };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    failoverWithQuorum() {
      const current = leaderNode();
      const expectedNext = nextCandidate(candidates, current.id.nodeId);
      const claimer = nodes.find((x) => x.id.nodeId === expectedNext)!;
      const msg = claimer.election.claimLeadership(
        claimer.id,
        current.lab.stateRoot,
        current.lab.sequence,
        current.lab.nullifierRoot,
      );
      if ("error" in msg) {
        return {
          ok: false,
          newLeader: "",
          epoch: current.election.state.epoch,
          error: msg.error,
        };
      }
      const body = {
        networkId: msg.networkId,
        domainId: msg.domainId,
        epoch: msg.epoch,
        leaderNodeId: msg.leaderNodeId,
        prevEpoch: msg.prevEpoch,
        continueFromRoot: msg.continueFromRoot,
        continueFromSequence: msg.continueFromSequence,
        continueFromNullifierRoot: msg.continueFromNullifierRoot,
        ts: msg.ts,
      };
      const voted = collectVotesFromVoters(
        nodes.map((n) => n.voter),
        body,
      );
      if (!voted.ok) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          error: `VOTE_LOCK:${voted.reason}`,
        };
      }
      const digest = newLeaderDigest(body);
      const diss = disseminateQcVotes(
        voteBoard,
        msg.epoch,
        digest,
        voted.votes,
      );
      if (!diss.ok) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          error: `VOTE_BOARD:${diss.reason}:${diss.nodeId}`,
        };
      }
      const cert = assembleQuorumCert(msg, voted.votes);
      const local = localFromElection(current.election, voteLog);
      const vr = verifyQuorumCert(
        cert,
        cfg,
        (id) => registry.publicKeyHex(id),
        { local },
      );
      if (!vr.ok) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          error: vr.reason,
        };
      }
      const pk = registry.publicKeyHex(msg.leaderNodeId)!;
      for (const n of nodes) {
        const r = n.election.applyNewLeader(msg, pk);
        if (!r.ok) {
          return {
            ok: false,
            newLeader: msg.leaderNodeId,
            epoch: msg.epoch,
            error: r.reason,
          };
        }
        n.lab.sequencerPublicKeyHex = pk;
        n.lab.sequencerNodeId = msg.leaderNodeId;
      }
      return { ok: true, newLeader: msg.leaderNodeId, epoch: msg.epoch };
    },
  };

  return api;
}

/**
 * Simulate E9: try to register two conflicting proposals — second fails.
 */
export function tryConflictingProposals(
  board: ProposalBoard,
  leaderId: string,
  networkId = "local",
  domainId = 1,
): { first: boolean; second: boolean; reason?: string } {
  const a = {
    digest: "digest-A",
    networkId,
    domainId,
    leaderNodeId: leaderId,
    sequence: 1,
    previousStateRoot: "GENESIS",
    newStateRoot: "FORK-A",
    nullifier: "nf-a",
    transitionId: "t-a",
  };
  const b = {
    ...a,
    digest: "digest-B",
    newStateRoot: "FORK-B",
    nullifier: "nf-b",
    transitionId: "t-b",
  };
  const r1 = board.register(a);
  const r2 = board.register(b);
  return {
    first: r1.ok,
    second: r2.ok,
    reason: !r2.ok ? r2.reason : undefined,
  };
}

/**
 * Simulate E4: two QCs with shared VoteBoard — second dissemination fails.
 */
export function tryConflictingQcDissemination(
  board: VoteBoard,
  voterIds: string[],
  epoch: number,
): { first: boolean; second: boolean; reason?: string } {
  const votesA = voterIds.map((id) => ({
    nodeId: id,
    signature: "00",
    digest: "D-A",
    epoch,
  }));
  const votesB = voterIds.map((id) => ({
    nodeId: id,
    signature: "00",
    digest: "D-B",
    epoch,
  }));
  const r1 = disseminateQcVotes(board, epoch, "D-A", votesA);
  const r2 = disseminateQcVotes(board, epoch, "D-B", votesB);
  return {
    first: r1.ok,
    second: r2.ok,
    reason: !r2.ok ? r2.reason : undefined,
  };
}
