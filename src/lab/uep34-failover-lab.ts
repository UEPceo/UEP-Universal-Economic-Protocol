/**
 * UEP-34.0–34.3 — Failover lab: simple vs quorum modes, heartbeat, equivocation checks.
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
  type NewLeaderMsg,
  type ElectionConfig,
  nextCandidate,
  type FailoverMode,
} from "./uep34-election.ts";
import {
  HeartbeatMonitor,
  signHeartbeat,
  verifyHeartbeat,
} from "./uep34-heartbeat.ts";
import {
  assembleQuorumCert,
  collectVotesFromVoters,
  verifyQuorumCert,
  localFromElection,
  majorityThreshold,
  Voter,
  type QuorumCert,
} from "./uep34-quorum.ts";

export type FailoverNode = {
  id: NodeIdentity;
  lab: LabNode;
  election: SequencerElection;
  monitor?: HeartbeatMonitor;
  hbCounter: number;
};

export type FailoverLab = {
  nodes: FailoverNode[];
  registry: NodeRegistry;
  cfg: ElectionConfig;
  /** Shared vote log for QC locking across the lab process. */
  voteLog: Map<string, Map<number, string>>;
  leaderId: () => string;
  commitAsLeader: (input: {
    newStateRoot: string;
    transitionId: string;
    nullifier: string;
  }) => { ok: true; sequence: number } | { ok: false; error: string };
  broadcastNewLeader: (
    msg: NewLeaderMsg,
  ) => { accepted: number; rejected: { nodeId: string; reason: string }[] };
  failover: () => {
    ok: boolean;
    newLeader: string;
    epoch: number;
    error?: string;
  };
  failoverWithQuorum: () => {
    ok: boolean;
    newLeader: string;
    epoch: number;
    cert?: QuorumCert;
    error?: string;
  };
  pulseHeartbeat: () => { ok: true } | { ok: false; error: string };
  startSilenceMonitors: (
    timeoutMs: number,
    onSilence: (nodeId: string, info: { leaderNodeId: string; epoch: number }) => void,
  ) => void;
  stopMonitors: () => void;
  acceptQuorumCert: (
    cert: QuorumCert,
  ) => { accepted: number; rejected: { nodeId: string; reason: string }[] };
};

export function bootFailoverLab(opts?: {
  n?: number;
  networkId?: string;
  domainId?: number;
  heartbeatTimeoutMs?: number;
  mode?: FailoverMode;
}): FailoverLab {
  const n = opts?.n ?? 3;
  const networkId = opts?.networkId ?? "local";
  const domainId = opts?.domainId ?? 1;
  const mode: FailoverMode = opts?.mode ?? "LAB-SIMPLE-FAILOVER";

  const ids: NodeIdentity[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(createNodeIdentity(`cand-${i}`));
  }
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
    heartbeatTimeoutMs: opts?.heartbeatTimeoutMs ?? 500,
    mode,
  };

  const voteLog = new Map<string, Map<number, string>>();
  const voters = new Map<string, Voter>();
  for (const id of ids) {
    voters.set(id.nodeId, new Voter(id, networkId, domainId));
  }

  const nodes: FailoverNode[] = ids.map((id) => {
    const election = new SequencerElection(cfg, "GENESIS");
    const lab = new LabNode(
      id,
      networkId,
      domainId,
      ids[0]!.publicKeyHex,
      ids[0]!.nodeId,
    );
    return { id, lab, election, hbCounter: 0 };
  });

  const leaderId = () => nodes[0]!.election.state.leaderNodeId;

  function leaderNode(): FailoverNode {
    const lid = leaderId();
    const found = nodes.find((x) => x.id.nodeId === lid);
    if (!found) throw new Error("LEADER_MISSING");
    return found;
  }

  const labApi: FailoverLab = {
    nodes,
    registry,
    cfg,
    voteLog,
    leaderId,
    commitAsLeader(input) {
      const leader = leaderNode();
      try {
        const env = leader.lab.propose({
          previousStateRoot: leader.lab.stateRoot,
          newStateRoot: input.newStateRoot,
          transitionId: input.transitionId,
          nullifier: input.nullifier,
        });
        // Equivocation check before apply
        for (const n of nodes) {
          const eq = n.election.noteLeaderProposal(
            n.election.state.epoch,
            env.sequence,
            env.newStateRoot,
          );
          if (!eq.ok) return { ok: false, error: eq.reason };
        }
        for (const n of nodes) {
          n.lab.sequencerPublicKeyHex = leader.id.publicKeyHex;
          n.lab.sequencerNodeId = leader.id.nodeId;
          const r = n.lab.apply(env);
          if (!r.ok) return { ok: false, error: `${n.id.nodeId}:${r.error}` };
          n.election.noteCommit(env.sequence, env.newStateRoot);
          n.monitor?.feed(
            leader.id.nodeId,
            n.election.state.epoch,
            // commits also count as liveness without advancing hb counter
          );
        }
        return { ok: true, sequence: env.sequence };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    broadcastNewLeader(msg) {
      if (mode === "LAB-QUORUM-FAILOVER") {
        return {
          accepted: 0,
          rejected: nodes.map((n) => ({
            nodeId: n.id.nodeId,
            reason: "QUORUM_REQUIRED",
          })),
        };
      }
      const rejected: { nodeId: string; reason: string }[] = [];
      let accepted = 0;
      const pk = registry.publicKeyHex(msg.leaderNodeId);
      if (!pk) {
        return {
          accepted: 0,
          rejected: nodes.map((n) => ({
            nodeId: n.id.nodeId,
            reason: "UNKNOWN_LEADER_KEY",
          })),
        };
      }
      for (const n of nodes) {
        const r = n.election.acceptNewLeader(msg, pk);
        if (r.ok) {
          accepted++;
          n.lab.sequencerPublicKeyHex = pk;
          n.lab.sequencerNodeId = msg.leaderNodeId;
          n.monitor?.resetLeader(msg.leaderNodeId, msg.epoch);
          n.hbCounter = 0;
        } else {
          rejected.push({ nodeId: n.id.nodeId, reason: r.reason });
        }
      }
      return { accepted, rejected };
    },
    failover() {
      if (mode === "LAB-QUORUM-FAILOVER") {
        return {
          ok: false,
          newLeader: "",
          epoch: leaderNode().election.state.epoch,
          error: "QUORUM_REQUIRED",
        };
      }
      const current = leaderNode();
      const expectedNext = nextCandidate(
        current.election.cfg.candidates,
        current.id.nodeId,
      );
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
      const br = labApi.broadcastNewLeader(msg);
      if (br.accepted !== nodes.length) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          error: `PARTIAL_ACCEPT:${br.rejected.map((r) => r.reason).join(",")}`,
        };
      }
      return { ok: true, newLeader: msg.leaderNodeId, epoch: msg.epoch };
    },
    failoverWithQuorum() {
      const current = leaderNode();
      const expectedNext = nextCandidate(
        current.election.cfg.candidates,
        current.id.nodeId,
      );
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
      const proposalBody = {
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
        [...voters.values()],
        proposalBody,
      );
      if (!voted.ok) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          error: `VOTE_LOCK:${voted.reason}:${voted.failedNode}`,
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
          cert,
          error: vr.reason,
        };
      }
      const br = labApi.acceptQuorumCert(cert);
      if (br.accepted !== nodes.length) {
        return {
          ok: false,
          newLeader: msg.leaderNodeId,
          epoch: msg.epoch,
          cert,
          error: `PARTIAL_QC:${br.rejected.map((r) => r.reason).join(",")}`,
        };
      }
      return {
        ok: true,
        newLeader: msg.leaderNodeId,
        epoch: msg.epoch,
        cert,
      };
    },
    acceptQuorumCert(cert) {
      const rejected: { nodeId: string; reason: string }[] = [];
      let accepted = 0;
      // Use first node's state as reference for continuity; all should match in lab
      const ref = nodes[0]!.election;
      const local = localFromElection(ref, voteLog);
      const vr = verifyQuorumCert(
        cert,
        cfg,
        (id) => registry.publicKeyHex(id),
        { local },
      );
      if (!vr.ok) {
        return {
          accepted: 0,
          rejected: nodes.map((n) => ({
            nodeId: n.id.nodeId,
            reason: vr.reason,
          })),
        };
      }
      const msg = cert.proposal as NewLeaderMsg;
      if (!msg.signature) {
        return {
          accepted: 0,
          rejected: nodes.map((n) => ({
            nodeId: n.id.nodeId,
            reason: "MISSING_CLAIMER_SIG",
          })),
        };
      }
      const pk = registry.publicKeyHex(msg.leaderNodeId);
      if (!pk) {
        return {
          accepted: 0,
          rejected: nodes.map((n) => ({
            nodeId: n.id.nodeId,
            reason: "UNKNOWN_LEADER_KEY",
          })),
        };
      }
      for (const n of nodes) {
        // applyNewLeader bypasses QUORUM_REQUIRED gate (QC already verified)
        const r = n.election.applyNewLeader(msg, pk);
        if (r.ok) {
          accepted++;
          n.lab.sequencerPublicKeyHex = pk;
          n.lab.sequencerNodeId = msg.leaderNodeId;
          n.monitor?.resetLeader(msg.leaderNodeId, msg.epoch);
          n.hbCounter = 0;
        } else {
          rejected.push({ nodeId: n.id.nodeId, reason: r.reason });
        }
      }
      return { accepted, rejected };
    },
    pulseHeartbeat() {
      const leader = leaderNode();
      leader.hbCounter += 1;
      const hb = signHeartbeat(leader.id, {
        networkId,
        domainId,
        epoch: leader.election.state.epoch,
        counter: leader.hbCounter,
        sequence: leader.lab.sequence,
        stateRoot: leader.lab.stateRoot,
        ts: Date.now(),
      });
      for (const n of nodes) {
        const v = verifyHeartbeat(hb, leader.id.publicKeyHex, {
          networkId,
          domainId,
          epoch: n.election.state.epoch,
          leaderNodeId: n.election.state.leaderNodeId,
        });
        if (!v.ok) return { ok: false, error: v.reason };
        const fed = n.monitor?.feed(hb.leaderNodeId, hb.epoch, hb.counter);
        if (n.monitor && fed === false) {
          return { ok: false, error: "HEARTBEAT_REPLAY" };
        }
      }
      return { ok: true };
    },
    startSilenceMonitors(timeoutMs, onSilence) {
      for (const n of nodes) {
        n.monitor?.stop();
        n.monitor = new HeartbeatMonitor({
          timeoutMs,
          leaderNodeId: n.election.state.leaderNodeId,
          epoch: n.election.state.epoch,
          onSilence: (info) => onSilence(n.id.nodeId, info),
        });
      }
    },
    stopMonitors() {
      for (const n of nodes) n.monitor?.stop();
    },
  };

  return labApi;
}

export { majorityThreshold };
