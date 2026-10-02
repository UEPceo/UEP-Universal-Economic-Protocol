/**
 * UEP-35.7.1 — Multi-node consensus + state convergence LAB.
 * Independent nodes (no shared app state). DATA vs CONSENSUS plane.
 */

import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
  type NodeIdentity,
} from "./node-identity.ts";
import { UepWorker } from "./uep35-worker.ts";
import type { DagBatchHeader } from "./uep35-dag.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { authorizeBatchTx } from "./uep-tx-auth.ts";
import {
  type UepSecurityProfile,
  profileRequiresTxAuth,
  profileRequiresAccountKeyBinding,
  profileRequiresDomainBinding,
} from "./uep-security-profile.ts";
import { SimulatedNetwork } from "./uep35-sim-network.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  isScheduledLeader,
  scheduledLeader,
  type ViewChangeRecord,
  type ViewChangeReason,
} from "./uep37-leader-schedule.ts";
import {
  signViewChangeVote,
  assembleViewChangeQC,
  verifyViewChangeQC,
  canAdoptViewChangeQC,
  type ViewChangeTarget,
} from "./uep37-view-change-qc.ts";
import {
  sealConsensusMsg,
  verifyConsensusMsg,
  proposalDigestFromPayload,
  type ConsensusEnvelope,
  type ProposalPayload,
  type VotePayload,
} from "./uep35-consensus-msg.ts";
import {
  signCommitVote,
  assembleCommitCert,
  verifyCommitCert,
  ProposalBoard,
  type TransitionProposal,
  type CommitCert,
  type CommitVote,
} from "./uep34-commit-cert.ts";
import {
  buildFinalityCertificate,
  type FinalityCertificate,
} from "./uep35-finality.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";
import { createHash } from "node:crypto";
import { NODE_PROTOCOL_VERSION, signEnvelope } from "./node-protocol.ts";
import { proposalFromEnvelope } from "./uep34-commit-cert.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import {
  HeightVoteLock,
  ProposalTracker,
  validateProposalSemantics,
  previousRootMatches,
  assertAggregateDigestBinding,
} from "./uep36-aggregate-semantics.ts";
import { softRestartNode, snapshotNodeConsensus } from "./uep36-node-snapshot.ts";
import {
  buildDigestAggregate,
  aggregateProposalPayload,
} from "./uep36-digest-agg.ts";

export type NodeStage = "none" | "dag_ready" | "proposed" | "committed" | "finalized";

export type IndependentNode = {
  id: string;
  identity: NodeIdentity;
  worker: UepWorker;
  /** Per-node registry copy — not shared object identity */
  registry: NodeRegistry;
  readyBatches: Set<string>;
  economic: LocalEconomicState | SmtEconomicState;
  /** proposalDigest → stage */
  stages: Map<string, NodeStage>;
  votes: Map<string, CommitVote[]>;
  seenMsgIds: Set<string>;
  seenVotes: Set<string>; // voter|digest
  voteLock: HeightVoteLock;
  proposalTracker: ProposalTracker;
  commitCerts: Map<string, CommitCert>;
  finalityCerts: Map<string, FinalityCertificate>;
  board: ProposalBoard;
  appliedBatches: Set<string>;
  pendingProposals: Map<string, import("./uep35-consensus-msg.ts").ProposalPayload>;
  byzantine?: boolean;
  byzantineMode?: "equivocate" | "double_vote" | "wrong_root" | "silent";
};

function encodeHeader(h: DagBatchHeader): string {
  return JSON.stringify(h);
}
function decodeHeader(s: string): DagBatchHeader {
  return JSON.parse(s) as DagBatchHeader;
}
function encodeBody(batchId: string, txs: BatchTx[]): string {
  return JSON.stringify({
    batchId,
    txs: txs.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      amount: t.amount.toString(),
      ...(t.auth ? { auth: t.auth } : {}),
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.holdId ? { holdId: t.holdId } : {}),
      ...(t.obligationId ? { obligationId: t.obligationId } : {}),
      ...(t.providerId ? { providerId: t.providerId } : {}),
      ...(t.price !== undefined ? { price: t.price.toString() } : {}),
    })),
  });
}
function decodeBody(s: string): { batchId: string; txs: BatchTx[] } {
  const j = JSON.parse(s) as {
    batchId: string;
    txs: Array<{
      id: string;
      from: string;
      to: string;
      amount: string;
      auth?: BatchTx["auth"];
      kind?: BatchTx["kind"];
      holdId?: string;
      obligationId?: string;
      providerId?: string;
      price?: string;
    }>;
  };
  return {
    batchId: j.batchId,
    txs: j.txs.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      amount: BigInt(t.amount),
      ...(t.auth ? { auth: t.auth } : {}),
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.holdId ? { holdId: t.holdId } : {}),
      ...(t.obligationId ? { obligationId: t.obligationId } : {}),
      ...(t.providerId ? { providerId: t.providerId } : {}),
      ...(t.price !== undefined ? { price: BigInt(t.price) } : {}),
    })),
  };
}

function cloneRegistry(src: NodeRegistry): NodeRegistry {
  const r = new NodeRegistry();
  for (const e of src.list()) r.register({ ...e });
  return r;
}

export function createIndependentNodes(
  n: number,
  opts?: {
    seed?: number;
    byzantineIds?: string[];
    byzantineMode?: IndependentNode["byzantineMode"];
    /** UEP-37: SMT roots instead of SHA256 lab roots */
    useSmtState?: boolean;
    smtDepth?: number;
    /** UEP-37.3: Poseidon leaves via uep-zk */
    poseidonZkLeaves?: boolean;
    initialBalances?: Record<string, bigint>;
  },
): { nodes: IndependentNode[]; templateRegistry: NodeRegistry } {
  const template = new NodeRegistry();
  const identities: NodeIdentity[] = [];
  for (let i = 0; i < n; i++) {
    const id = createNodeIdentity(`mn-${i}`);
    identities.push(id);
    template.register(
      registryFromIdentity(id, {
        networkId: "lab-mn",
        domainId: 1,
        role: "replica",
      }),
    );
  }
  const byz = new Set(opts?.byzantineIds ?? []);
  const balances = opts?.initialBalances ?? {
    s0: 100_000n,
    s1: 100_000n,
    s2: 100_000n,
    r0: 0n,
    r1: 0n,
    r2: 0n,
    r3: 0n,
  };
  const nodes: IndependentNode[] = identities.map((id) => ({
    id: id.nodeId,
    identity: id,
    worker: new UepWorker({
      workerId: id.nodeId,
      epoch: 0,
      identity: id,
      mempool: { maxBatchSize: 64, maxBatchBytes: 100_000, maxPending: 10_000 },
    }),
    registry: cloneRegistry(template),
    readyBatches: new Set(),
    economic: opts?.useSmtState
      ? SmtEconomicState.genesis(balances, {
          ...(opts?.smtDepth !== undefined && opts.smtDepth !== 32
            ? { testOnlyDepth: opts.smtDepth, isTestFixture: true }
            : {}),
          leafMode: opts?.poseidonZkLeaves ? "poseidon-zk" : "structural",
          labDistinctIndices: true,
        })
      : new LocalEconomicState(balances),
    stages: new Map(),
    votes: new Map(),
    seenMsgIds: new Set(),
    seenVotes: new Set(),
    voteLock: new HeightVoteLock(),
    proposalTracker: new ProposalTracker(),
    commitCerts: new Map(),
    finalityCerts: new Map(),
    board: new ProposalBoard(),
    appliedBatches: new Set(),
    pendingProposals: new Map(),
    byzantine: byz.has(id.nodeId),
    byzantineMode: byz.has(id.nodeId) ? opts?.byzantineMode ?? "silent" : undefined,
  }));
  return { nodes, templateRegistry: template };
}

export class MultiNodeCluster {
  nodes: IndependentNode[];
  net: SimulatedNetwork;
  peers: string[];
  epoch = 0;
  /** Global consensus sequence (not per-worker DAG height). */
  globalSeq = 0;
  /** UEP-37.6: only scheduled leader may propose at next height */
  singleLeaderPerHeight = true;
  /** S2-3: require Ed25519 auth on every BatchTx */
  requireTxAuth = false;
  securityProfile: UepSecurityProfile = "LAB_LEGACY";
  /** ECON-05: proposals must carry and match economicTipCommitment */
  requireEconomicCommitment = true;
  /** accountId → publicKeyHex (required under secure profiles) */
  accountKeys: Record<string, string> = {};
  /** UEP-37.7 view for next height */
  heightView = 0;
  ticksSinceProgress = 0;
  /** 0 = disabled; else auto advanceView after N tick() steps without progress */
  leaderTimeoutTicks = 0;
  viewChanges: ViewChangeRecord[] = [];
  labTick = 0;
  stats = {
    proposals: 0,
    votes: 0,
    commits: 0,
    finalities: 0,
    rejected: 0,
  };

  constructor(
    n: number,
    seed = 1,
    opts?: {
      byzantineIds?: string[];
      byzantineMode?: IndependentNode["byzantineMode"];
      lossRate?: number;
      useSmtState?: boolean;
      smtDepth?: number;
      poseidonZkLeaves?: boolean;
      initialBalances?: Record<string, bigint>;
    },
  ) {
    const { nodes } = createIndependentNodes(n, opts);
    this.nodes = nodes;
    this.net = new SimulatedNetwork({
      seed,
      defaultLatencyMs: 20,
      lossRate: opts?.lossRate ?? 0,
      dupRate: opts?.lossRate && opts.lossRate > 0 ? 0.05 : 0,
    });
    this.peers = nodes.map((x) => x.id);
  }

  /** Node ids used for leader schedule (all cluster members). */
  scheduleNodeIds(): string[] {
    return this.nodes.map((n) => n.id);
  }

  nextProposeHeight(): number {
    return this.globalSeq + 1;
  }

  leaderForNextHeight(): string {
    return scheduledLeader(
      this.nextProposeHeight(),
      this.scheduleNodeIds(),
      this.heightView,
    );
  }

  advanceView(reason: ViewChangeReason = "MANUAL"): ViewChangeRecord {
    const height = this.nextProposeHeight();
    const ids = this.scheduleNodeIds();
    const fromView = this.heightView;
    const previousLeader = scheduledLeader(height, ids, fromView);
    const target: ViewChangeTarget = {
      networkId: "uep-lab",
      domainId: 0,
      epoch: this.epoch,
      height,
      nextView: fromView + 1,
      reason,
    };
    // In-process: collect votes from all non-byzantine nodes → QC → adopt
    const votes = this.nodes
      .filter((n) => !n.byzantine)
      .map((n) => signViewChangeVote(n.identity, target));
    const assembled = assembleViewChangeQC(
      target,
      votes,
      ids,
      (id) => this.node(id).identity.publicKeyHex,
    );
    if (!assembled.ok) {
      throw new Error(`VIEW_CHANGE_QC_FAILED:${assembled.reason}`);
    }
    const vr = verifyViewChangeQC(
      assembled.qc,
      ids,
      (id) => this.node(id).identity.publicKeyHex,
    );
    if (!vr.ok) throw new Error(`VIEW_CHANGE_QC_VERIFY:${vr.reason}`);
    const adopt = canAdoptViewChangeQC(assembled.qc, {
      height,
      heightView: fromView,
      networkId: "uep-lab",
      domainId: 0,
      epoch: this.epoch,
    });
    if (!adopt.ok) throw new Error(`VIEW_CHANGE_ADOPT:${adopt.reason}`);

    this.heightView = target.nextView;
    const newLeader = scheduledLeader(height, ids, this.heightView);
    const rec: ViewChangeRecord = {
      height,
      fromView,
      toView: this.heightView,
      previousLeader,
      newLeader,
      reason,
      tick: this.labTick,
    };
    this.viewChanges.push(rec);
    this.ticksSinceProgress = 0;
    return rec;
  }

  noteHeightProgress(): void {
    this.heightView = 0;
    this.ticksSinceProgress = 0;
  }

  effectiveRequireAuth(): boolean {
    return this.requireTxAuth || profileRequiresTxAuth(this.securityProfile);
  }

  effectiveRequireKeyBinding(): boolean {
    // E-2: any path that requires auth also requires account key binding
    return (
      this.requireTxAuth ||
      profileRequiresAccountKeyBinding(this.securityProfile)
    );
  }

  effectiveRequireDomain(): boolean {
    return profileRequiresDomainBinding(this.securityProfile);
  }

  authOpts() {
    return {
      requireAuth: this.effectiveRequireAuth(),
      requireAccountKeyBinding: this.effectiveRequireKeyBinding(),
      accountKeys: this.accountKeys,
      requireDomain: this.effectiveRequireDomain(),
      expectedNetworkId: "uep-lab",
      expectedDomainId: 0,
    };
  }

  assertProposerAllowed(nodeId: string): boolean {
    if (!this.singleLeaderPerHeight) return true;
    const seqs = this.nodes.map((n) => n.economic.sequence);
    const minS = Math.min(...seqs);
    const maxS = Math.max(...seqs);
    if (minS !== maxS) return false;
    if (minS !== this.globalSeq) return false;
    return isScheduledLeader(
      nodeId,
      this.nextProposeHeight(),
      this.scheduleNodeIds(),
      this.heightView,
    );
  }

    node(id: string): IndependentNode {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error("unknown node");
    return n;
  }

  bftN(): number {
    return this.nodes.filter((n) => !n.byzantine).length || this.nodes.length;
  }

  /** UEP-36.6 — partition DATA+CONSENSUS traffic between groups */
  partition(groupA: string[], groupB: string[]): void {
    this.net.partition(groupA, groupB);
  }

  heal(): void {
    this.net.heal();
  }

  /** UEP-36.9 — soft restart: clear ephemeral de-dupe, keep vote locks + economic tip */
  softRestart(nodeId: string): ReturnType<typeof snapshotNodeConsensus> {
    const n = this.node(nodeId);
    const snap = snapshotNodeConsensus(n);
    softRestartNode(n, snap);
    return snap;
  }


  /**
   * After heal: nodes with certificates rebroadcast DATA + COMMIT/FINALITY
   * so partitioned peers can catch up (LAB).
   */
  resyncAfterHeal(): void {
    for (const node of this.nodes) {
      if (node.byzantine) continue;
      // Re-push ready batch headers/bodies
      for (const batchId of node.readyBatches) {
        const header = node.worker.dag.getHeader(batchId);
        const body = node.worker.dag.getBody(batchId);
        if (header) {
          this.net.broadcast(
            node.id,
            this.peers,
            "BATCH_HEADER",
            Buffer.from(encodeHeader(header), "utf8"),
          );
        }
        if (header && body) {
          this.net.broadcast(
            node.id,
            this.peers,
            "BATCH_BODY",
            Buffer.from(encodeBody(batchId, body), "utf8"),
          );
        }
      }
      for (const [digest, pend] of node.pendingProposals) {
        const env = sealConsensusMsg(
          node.identity,
          "PROPOSAL",
          this.epoch,
          pend.height,
          pend,
        );
        this.net.broadcast(
          node.id,
          this.peers,
          "PROPOSAL",
          Buffer.from(JSON.stringify(env), "utf8"),
        );
      }
      for (const [digest, cert] of node.commitCerts) {
        const pend = node.pendingProposals.get(digest);
        const batchId = pend?.batchId ?? cert.proposal.transitionId.slice(0, 32);
        const cenv = sealConsensusMsg(
          node.identity,
          "COMMIT_CERT",
          this.epoch,
          cert.proposal.sequence,
          {
            cert,
            batchId,
            batchIds: pend?.batchIds,
            stateRoot: cert.proposal.newStateRoot,
            epoch: this.epoch,
            height: cert.proposal.sequence,
          },
        );
        this.net.broadcast(
          node.id,
          this.peers,
          "COMMIT_CERT",
          Buffer.from(JSON.stringify(cenv), "utf8"),
        );
      }
      for (const [digest, fc] of node.finalityCerts) {
        const pend = node.pendingProposals.get(digest);
        const fenv = sealConsensusMsg(
          node.identity,
          "FINALITY_CERT",
          this.epoch,
          fc.sequence,
          {
            cert: fc,
            batchId: pend?.batchId ?? "",
            batchIds: pend?.batchIds,
            stateRoot: fc.stateRoot,
          },
        );
        this.net.broadcast(
          node.id,
          this.peers,
          "FINALITY_CERT",
          Buffer.from(JSON.stringify(fenv), "utf8"),
        );
      }
    }
  }



  /** DATA: propose batch from producer; then consensus proposal with stateRoot. */
  proposeFrom(nodeId: string, txs: BatchTx[]): {
    header: DagBatchHeader;
    proposalDigest: string;
    stateRoot: string;
  } | null {
    if (!this.assertProposerAllowed(nodeId)) return null;
    const n = this.node(nodeId);
    for (const tx of txs) n.worker.admit(tx);
    const produced = n.worker.produceBatch();
    if (!produced) return null;

    // DATA plane: header
    const payload = Buffer.from(encodeHeader(produced.header), "utf8");
    this.net.broadcast(n.id, this.peers, "BATCH_HEADER", payload);
    n.readyBatches.add(produced.header.batchId);

    const prev = n.economic.previousRoot();
    let stateRoot = n.economic.previewRoot(produced.txs);
    if (!stateRoot) return null;

    if (n.byzantine && n.byzantineMode === "wrong_root") {
      stateRoot = "DEADBEEF" + stateRoot.slice(8);
    }

    this.globalSeq += 1;
    const propPayload: ProposalPayload = {
      batchId: produced.header.batchId,
      txDigest: produced.header.txDigest,
      stateRoot,
      epoch: this.epoch,
      height: this.globalSeq,
      previousStateRoot: prev,
    };

    // Equivocation: different roots to different peers
    if (n.byzantine && n.byzantineMode === "equivocate") {
      for (let i = 0; i < this.peers.length; i++) {
        const peer = this.peers[i]!;
        if (peer === n.id) continue;
        const alt = {
          ...propPayload,
          stateRoot: i % 2 === 0 ? stateRoot : "ALT-" + stateRoot.slice(0, 60),
        };
        const env = sealConsensusMsg(
          n.identity,
          "PROPOSAL",
          this.epoch,
          produced.header.height,
          alt,
        );
        this.net.send(
          n.id,
          peer,
          "PROPOSAL",
          Buffer.from(JSON.stringify(env), "utf8"),
        );
      }
      this.stats.proposals++;
      return {
        header: produced.header,
        proposalDigest: proposalDigestFromPayload(propPayload),
        stateRoot,
      };
    }

    const env = sealConsensusMsg(
      n.identity,
      "PROPOSAL",
      this.epoch,
      propPayload.height,
      propPayload,
    );
    this.net.broadcast(
      n.id,
      this.peers,
      "PROPOSAL",
      Buffer.from(JSON.stringify(env), "utf8"),
    );
    this.stats.proposals++;
    const digest = proposalDigestFromPayload(propPayload);
    n.stages.set(digest, "proposed");
    n.pendingProposals.set(digest, propPayload);
    this.tryVoteOnProposal(n, digest, propPayload);
    return {
      header: produced.header,
      proposalDigest: digest,
      stateRoot,
    };
  }


  /**
   * UEP-36.4 — Multi-batch DigestAggregate proposal on multi-node LAB.
   * DATA: disseminate all batch headers/bodies; CONSENSUS: one aggregate proposal.
   */
  proposeAggregateFrom(
    nodeId: string,
    batches: { batchId?: string; txs: BatchTx[] }[],
  ): {
    aggregateDigest: string;
    proposalDigest: string;
    stateRoot: string;
    batchIds: string[];
  } | null {
    if (batches.length === 0) return null;
    if (!this.assertProposerAllowed(nodeId)) return null;
    const n = this.node(nodeId);
    const producedList: { batchId: string; txDigest: string; txs: BatchTx[] }[] = [];

    // S1-1 + S2-3: filter before admit so batch bodies match the proposal root
    const probe = n.economic.clone();
    for (const b of batches) {
      const viable: BatchTx[] = [];
      for (const tx of b.txs) {
        const a = authorizeBatchTx(tx, this.authOpts());
        if (!a.ok) continue;
        const r = probe.applyTransfers([tx]);
        if (r.ok) viable.push(tx);
      }
      if (viable.length === 0) continue;
      for (const tx of viable) n.worker.admit(tx);
      const produced = n.worker.produceBatch();
      if (!produced) return null;
      producedList.push({
        batchId: produced.header.batchId,
        txDigest: produced.header.txDigest,
        txs: produced.txs,
      });
      this.net.broadcast(
        n.id,
        this.peers,
        "BATCH_HEADER",
        Buffer.from(encodeHeader(produced.header), "utf8"),
      );
      this.net.broadcast(
        n.id,
        this.peers,
        "BATCH_BODY",
        Buffer.from(encodeBody(produced.header.batchId, produced.txs), "utf8"),
      );
      n.readyBatches.add(produced.header.batchId);
      n.worker.dag.isReady(produced.header.batchId);
    }
    if (producedList.length === 0) return null;

    const prev = n.economic.previousRoot();
    const allTxs: BatchTx[] = [];
    for (const p of producedList) allTxs.push(...p.txs);
    let exec;
    try {
      exec = parallelSafeScheduleApply(n.economic, allTxs);
    } catch {
      return null; // insufficient funds / invalid schedule — no proposal
    }
    if (!exec.fullStateEqual) return null;
    let stateRoot = exec.scheduledRoot;
    if (n.byzantine && n.byzantineMode === "wrong_root") {
      stateRoot = "DEADBEEF" + stateRoot.slice(8);
    }
    const tipProbe = n.economic.clone();
    const tipApply = tipProbe.applyTransfers(allTxs);
    let economicCommitment: string | undefined;
    if (tipApply.ok) {
      tipProbe.commitLogicalHeight();
      if (typeof (tipProbe as { economicTipCommitment?: () => string }).economicTipCommitment === "function") {
        economicCommitment = (tipProbe as { economicTipCommitment: () => string }).economicTipCommitment();
      }
    }
    if (this.requireEconomicCommitment && !economicCommitment) return null;

    this.globalSeq += 1;
    const height = this.globalSeq;
    const entries = producedList.map((p) => ({
      batchId: p.batchId,
      txDigest: p.txDigest,
    }));
    const agg = buildDigestAggregate(this.epoch, height, prev, entries);
    const batchIds = producedList.map((p) => p.batchId).slice().sort();
    const propPayload: ProposalPayload = {
      batchId: batchIds[0]!,
      txDigest: agg.aggregateDigest,
      stateRoot,
      epoch: this.epoch,
      height,
      previousStateRoot: prev,
      aggregateDigest: agg.aggregateDigest,
      batchIds,
      entryDigests: entries,
      ...(economicCommitment ? { economicCommitment } : {}),
    };
    {
      const sem = validateProposalSemantics(propPayload);
      if (!sem.ok) return null;
    }

    const env = sealConsensusMsg(
      n.identity,
      "PROPOSAL",
      this.epoch,
      height,
      propPayload,
    );
    this.net.broadcast(
      n.id,
      this.peers,
      "PROPOSAL",
      Buffer.from(JSON.stringify(env), "utf8"),
    );
    this.stats.proposals++;
    const digest = proposalDigestFromPayload(propPayload);
    n.stages.set(digest, "proposed");
    n.pendingProposals.set(digest, propPayload);
    this.tryVoteOnProposal(n, digest, propPayload);
    return {
      aggregateDigest: agg.aggregateDigest,
      proposalDigest: digest,
      stateRoot,
      batchIds,
    };
  }

  /**
   * LAB attack: same height, two different aggregate proposals to different peers.
   * Honest nodes must not vote both; vote lock + tracker produce evidence.
   */
  proposeAggregateEquivocation(
    nodeId: string,
    batches: Array<{ txs: BatchTx[] }>,
  ): { digestA: string; digestB: string; height: number } | null {
    if (batches.length === 0) return null;
    const n = this.node(nodeId);
    const producedList: { batchId: string; txDigest: string; txs: BatchTx[] }[] = [];
    for (const b of batches) {
      for (const tx of b.txs) n.worker.admit(tx);
      const produced = n.worker.produceBatch();
      if (!produced) return null;
      producedList.push({
        batchId: produced.header.batchId,
        txDigest: produced.header.txDigest,
        txs: produced.txs,
      });
      this.net.broadcast(
        n.id,
        this.peers,
        "BATCH_HEADER",
        Buffer.from(encodeHeader(produced.header), "utf8"),
      );
      this.net.broadcast(
        n.id,
        this.peers,
        "BATCH_BODY",
        Buffer.from(encodeBody(produced.header.batchId, produced.txs), "utf8"),
      );
      n.readyBatches.add(produced.header.batchId);
    }
    const prev = n.economic.previousRoot();
    const allTxs: BatchTx[] = [];
    for (const p of producedList) allTxs.push(...p.txs);
    const exec = parallelSafeScheduleApply(n.economic, allTxs);
    if (!exec.fullStateEqual) return null;
    this.globalSeq += 1;
    const height = this.globalSeq;
    const entries = producedList.map((p) => ({
      batchId: p.batchId,
      txDigest: p.txDigest,
    }));
    const agg = buildDigestAggregate(this.epoch, height, prev, entries);
    const batchIds = producedList.map((p) => p.batchId).slice().sort();
    const base: ProposalPayload = {
      batchId: batchIds[0]!,
      txDigest: agg.aggregateDigest,
      stateRoot: exec.scheduledRoot,
      epoch: this.epoch,
      height,
      previousStateRoot: prev,
      aggregateDigest: agg.aggregateDigest,
      batchIds,
      entryDigests: entries,
    };
    // Poison alternate: flip stateRoot only → different proposalDigest
    const alt: ProposalPayload = {
      ...base,
      stateRoot: "EE".repeat(32),
    };
    const digestA = proposalDigestFromPayload(base);
    const digestB = proposalDigestFromPayload(alt);
    for (let i = 0; i < this.peers.length; i++) {
      const peer = this.peers[i]!;
      if (peer === n.id) continue;
      const payload = i % 2 === 0 ? base : alt;
      const env = sealConsensusMsg(
        n.identity,
        "PROPOSAL",
        this.epoch,
        height,
        payload,
      );
      this.net.send(
        n.id,
        peer,
        "PROPOSAL",
        Buffer.from(JSON.stringify(env), "utf8"),
      );
    }
    this.stats.proposals += 2;
    return { digestA, digestB, height };
  }

  tick(ms = 25, steps = 30): void {
    const seqBefore = Math.min(...this.nodes.map((n) => n.economic.sequence));
    for (let i = 0; i < steps; i++) {
      this.labTick += 1;
      this.net.advance(ms);
      const delivered = this.net.drain();
      for (const [to, msgs] of delivered) {
        const node = this.nodes.find((x) => x.id === to);
        if (!node) continue;
        for (const m of msgs) {
          this.handle(node, m.from, m.kind, m.payload);
        }
      }
      for (const node of this.nodes) {
        if (node.byzantine) continue;
        this.tryAssemble(node);
      }
    }
    const seqAfter = Math.min(...this.nodes.map((n) => n.economic.sequence));
    if (seqAfter > seqBefore) {
      this.globalSeq = Math.max(this.globalSeq, seqAfter);
      this.noteHeightProgress();
    } else if (this.leaderTimeoutTicks > 0 && this.singleLeaderPerHeight) {
      // Only count timeout while the cluster is synced and waiting for next height
      const seqs = this.nodes.map((n) => n.economic.sequence);
      const minS = Math.min(...seqs);
      const maxS = Math.max(...seqs);
      if (minS === maxS && minS === this.globalSeq) {
        this.ticksSinceProgress += steps;
        if (this.ticksSinceProgress >= this.leaderTimeoutTicks) {
          this.advanceView("SILENT_LEADER_TIMEOUT");
        }
      }
    }
  }

  private handle(
    node: IndependentNode,
    from: string,
    kind: string,
    payload: Uint8Array,
  ): void {
    const text = Buffer.from(payload).toString("utf8");

    if (kind === "BATCH_HEADER") {
      if (node.byzantine && node.byzantineMode === "silent") return;
      const h = decodeHeader(text);
      const r = node.worker.announceHeader(h, true, node.registry);
      if (!r.ok) {
        this.stats.rejected++;
        return;
      }
      if (!node.worker.dag.hasBody(h.batchId)) {
        this.net.send(
          node.id,
          from,
          "BATCH_BODY_REQ",
          Buffer.from(JSON.stringify({ batchId: h.batchId }), "utf8"),
        );
      }
      return;
    }
    if (kind === "BATCH_BODY_REQ") {
      const { batchId } = JSON.parse(text) as { batchId: string };
      const body = node.worker.dag.getBody(batchId);
      if (!body) return;
      this.net.send(
        node.id,
        from,
        "BATCH_BODY",
        Buffer.from(encodeBody(batchId, body), "utf8"),
      );
      return;
    }
    if (kind === "BATCH_BODY") {
      const { batchId, txs } = decodeBody(text);
      const header = node.worker.dag.getHeader(batchId);
      if (!header) return;
      const r = node.worker.ingestRecovery(header, txs);
      if (r.ok && node.worker.dag.isReady(batchId)) {
        node.readyBatches.add(batchId);
        node.stages.set(batchId, "dag_ready");
        for (const [digest, p] of node.pendingProposals) {
          const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
          if (ids.includes(batchId)) this.tryVoteOnProposal(node, digest, p);
        }
      }
      return;
    }

    // CONSENSUS plane
    if (
      kind === "PROPOSAL" ||
      kind === "VOTE" ||
      kind === "COMMIT_CERT" ||
      kind === "FINALITY_CERT"
    ) {
      let env: ConsensusEnvelope;
      try {
        env = JSON.parse(text) as ConsensusEnvelope;
      } catch {
        this.stats.rejected++;
        return;
      }
      this.handleConsensus(node, env);
    }
  }

  private handleConsensus(node: IndependentNode, env: ConsensusEnvelope): void {
    if (node.seenMsgIds.has(env.msgId)) return; // dup
    const pk = node.registry.publicKeyHex(env.sender);
    if (!pk || !node.registry.isActive(env.sender)) {
      this.stats.rejected++;
      return;
    }
    if (!verifyConsensusMsg(env, pk)) {
      this.stats.rejected++;
      return;
    }
    node.seenMsgIds.add(env.msgId);

    if (env.type === "PROPOSAL") {
      if (node.byzantine) return;
      const p = JSON.parse(env.payload) as ProposalPayload;
      if (this.singleLeaderPerHeight) {
        const ids = this.scheduleNodeIds();
        let leaderOk = false;
        for (let v = 0; v < ids.length; v++) {
          if (scheduledLeader(p.height, ids, v) === env.sender) {
            leaderOk = true;
            break;
          }
        }
        if (!leaderOk) {
          this.stats.rejected++;
          return;
        }
        if (p.height !== node.economic.sequence + 1) {
          this.stats.rejected++;
          return;
        }
      }
      const sem = validateProposalSemantics(p);
      if (!sem.ok) {
        this.stats.rejected++;
        return;
      }
      const digBind = assertAggregateDigestBinding(p);
      if (!digBind.ok) {
        this.stats.rejected++;
        return;
      }
      const digest = proposalDigestFromPayload(p);
      const obs = node.proposalTracker.observe(env.sender, p.epoch, p.height, digest);
      if (obs.equivocation) {
        node.voteLock.noteConflictingProposals(
          p.epoch,
          p.height,
          obs.digests[0]!,
          obs.digests[1]!,
          env.sender,
        );
        // Do not vote for a conflicting second proposal at this height
        const locked = node.voteLock.get(p.epoch, p.height);
        if (locked && locked !== digest) {
          this.stats.rejected++;
          node.pendingProposals.set(digest, p); // keep for evidence, no vote
          return;
        }
      }
      node.pendingProposals.set(digest, p);
      node.stages.set(digest, "proposed");
      this.tryVoteOnProposal(node, digest, p);
      return;
    }

    if (env.type === "VOTE") {
      if (node.byzantine) return;
      const v = JSON.parse(env.payload) as VotePayload & {
        signature?: string;
        nodeId?: string;
      };
      const voteKey = `${env.sender}|${v.proposalDigest}`;
      if (node.seenVotes.has(voteKey)) return; // no double count
      node.seenVotes.add(voteKey);
      // Verify vote signature via commit vote body
      const vote: CommitVote = {
        nodeId: env.sender,
        proposalDigest: v.proposalDigest,
        signature: (JSON.parse(env.payload) as { commitSig: string }).commitSig,
      };
      const list = node.votes.get(v.proposalDigest) ?? [];
      list.push(vote);
      node.votes.set(v.proposalDigest, list);
      this.stats.votes++;
      return;
    }

    if (env.type === "COMMIT_CERT") {
      if (node.byzantine) return;
      const payload = JSON.parse(env.payload) as {
        cert: CommitCert;
        batchId: string;
        stateRoot: string;
        epoch: number;
        height: number;
      };
      if (
        payload.cert.proposal.newStateRoot !== payload.stateRoot ||
        payload.cert.proposal.sequence !== payload.height
      ) {
        this.stats.rejected++;
        return;
      }
      const candidates = this.nodes.map((x) => x.id);
      const keys: Record<string, string> = {};
      for (const e of node.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      // Register proposal on board for verify
      node.board.register(payload.cert.proposal);
      const vr = verifyCommitCert(
        payload.cert,
        candidates,
        (id) => keys[id],
        node.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) {
        this.stats.rejected++;
        return;
      }
      node.commitCerts.set(payload.cert.proposal.digest, payload.cert);
      node.stages.set(payload.cert.proposal.digest, "committed");
      this.stats.commits++;
      // Restore aggregate pending from cert payload if peer missed PROPOSAL
      const pl = payload as {
        batchId: string;
        batchIds?: string[];
        stateRoot: string;
      };
      if (
        pl.batchIds &&
        pl.batchIds.length > 0 &&
        !node.pendingProposals.has(payload.cert.proposal.digest)
      ) {
        node.pendingProposals.set(payload.cert.proposal.digest, {
          batchId: pl.batchId,
          txDigest: "",
          stateRoot: pl.stateRoot,
          epoch: this.epoch,
          height: payload.cert.proposal.sequence,
          previousStateRoot: payload.cert.proposal.previousStateRoot,
          batchIds: pl.batchIds,
          aggregateDigest: payload.cert.proposal.transitionId,
        });
      }
      this.applyIfPossible(node, payload.batchId, payload.stateRoot, payload.cert);
      return;
    }

    if (env.type === "FINALITY_CERT") {
      if (node.byzantine) return;
      const payload = JSON.parse(env.payload) as {
        cert: FinalityCertificate;
        batchId: string;
        stateRoot: string;
      };
      if (payload.cert.stateRoot !== payload.stateRoot) {
        this.stats.rejected++;
        return;
      }
      if (node.economic.isFinalized(payload.batchId)) return;
      // Must already be committed with matching root
      const cc = node.commitCerts.get(payload.cert.proposalDigest);
      if (!cc || cc.proposal.newStateRoot !== payload.stateRoot) {
        this.stats.rejected++;
        return;
      }
      node.finalityCerts.set(payload.cert.proposalDigest, payload.cert);
      node.economic.markFinalized(payload.batchId);
      {
        const pendF =
          node.pendingProposals.get(payload.cert.proposalDigest) ??
          undefined;
        const ids =
          (payload as { batchIds?: string[] }).batchIds ??
          pendF?.batchIds;
        if (ids) {
          for (const id of ids) node.economic.markFinalized(id);
        }
      }
      node.stages.set(payload.cert.proposalDigest, "finalized");
      this.stats.finalities++;
    }
  }

  private tryVoteOnProposal(
    node: IndependentNode,
    digest: string,
    p: ProposalPayload,
  ): void {
    // S1B-1: never re-evaluate a proposal already at or below applied sequence
    if (typeof p.height === "number" && p.height <= node.economic.sequence) {
      return;
    }
    const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
    for (const id of ids) {
      if (!node.worker.dag.isReady(id)) return;
    }
    const allTxs: BatchTx[] = [];
    for (const id of ids) {
      const body = node.worker.dag.getBody(id);
      if (!body) return;
      allTxs.push(...body);
    }
    // S2-3 auth gate
    for (const tx of allTxs) {
      const a = authorizeBatchTx(tx, this.authOpts());
      if (!a.ok) {
        this.stats.rejected++;
        return;
      }
    }
    let expected: string | null;
    try {
      if (ids.length > 1 || p.aggregateDigest) {
        const exec = parallelSafeScheduleApply(node.economic, allTxs);
        expected = exec.scheduledRoot;
      } else {
        expected = node.economic.previewRoot(allTxs);
      }
    } catch {
      // S1B-1: INSUFFICIENT / schedule errors must not abort the cluster tick
      this.stats.rejected++;
      return;
    }
    if (expected !== p.stateRoot) {
      this.stats.rejected++;
      return;
    }
    if (p.economicCommitment) {
      const tipC = node.economic.clone();
      try {
        const tr = tipC.applyTransfers(allTxs);
        if (!tr.ok) {
          this.stats.rejected++;
          return;
        }
        tipC.commitLogicalHeight();
        const tip =
          typeof (tipC as { economicTipCommitment?: () => string }).economicTipCommitment ===
          "function"
            ? (tipC as { economicTipCommitment: () => string }).economicTipCommitment()
            : null;
        if (tip !== p.economicCommitment) {
          this.stats.rejected++;
          return;
        }
      } catch {
        this.stats.rejected++;
        return;
      }
    } else if (this.requireEconomicCommitment) {
      this.stats.rejected++;
      return;
    }
    const prevOk = previousRootMatches(node.economic.previousRoot(), p.previousStateRoot);
    if (!prevOk.ok) {
      this.stats.rejected++;
      return;
    }
    const lock = node.voteLock.tryLock(p.epoch, p.height, digest);
    if (!lock.ok) {
      this.stats.rejected++;
      return;
    }
    if (node.seenVotes.has(`${node.id}|${digest}`)) return;
    this.castVote(node, digest, p);
  }

  private castVote(node: IndependentNode, digest: string, p: ProposalPayload): void {
    if (node.byzantine && node.byzantineMode === "double_vote") {
      // vote for two digests
      const v1 = signCommitVote(node.identity, digest);
      const v2 = signCommitVote(node.identity, digest + "-other");
      for (const vote of [v1, v2]) {
        const payload = {
          proposalDigest: vote.proposalDigest,
          batchId: p.batchId,
          stateRoot: p.stateRoot,
          commitSig: vote.signature,
        };
        const env = sealConsensusMsg(
          node.identity,
          "VOTE",
          this.epoch,
          p.height,
          payload,
        );
        this.net.broadcast(
          node.id,
          this.peers,
          "VOTE",
          Buffer.from(JSON.stringify(env), "utf8"),
        );
      }
      return;
    }

    const vote = signCommitVote(node.identity, digest);
    const payload = {
      proposalDigest: digest,
      batchId: p.batchId,
      stateRoot: p.stateRoot,
      commitSig: vote.signature,
    };
    const env = sealConsensusMsg(
      node.identity,
      "VOTE",
      this.epoch,
      p.height,
      payload,
    );
    this.net.broadcast(
      node.id,
      this.peers,
      "VOTE",
      Buffer.from(JSON.stringify(env), "utf8"),
    );
    // self-count
    const list = node.votes.get(digest) ?? [];
    list.push(vote);
    node.votes.set(digest, list);
    node.seenVotes.add(`${node.id}|${digest}`);
  }

  private tryAssemble(node: IndependentNode): void {
    const gate = assertBftConfig(this.nodes.length, "BFT-CLASSIC");
    if (!gate.ok) return;
    const need = gate.params.quorum;

    for (const [digest, votes] of node.votes) {
      if (node.commitCerts.has(digest)) continue;
      // unique voters
      const byVoter = new Map<string, CommitVote>();
      for (const v of votes) byVoter.set(v.nodeId, v);
      if (byVoter.size < need) continue;

      // Build TransitionProposal from first known proposal context
      // Find batch from any vote payload path — use economic preview from ready batches
      // Reconstruct minimal proposal via envelope from this node as leader proxy
      const leader = this.nodes[0]!;
      // Need proposal fields: search stages
      let batchId: string | null = null;
      let stateRoot: string | null = null;
      let height = 0;
      // Prefer pending proposal (carries global consensus height + previousRoot)
      const pending = node.pendingProposals.get(digest);
      if (pending && proposalDigestFromPayload(pending) === digest) {
        const ids =
          pending.batchIds && pending.batchIds.length > 0
            ? pending.batchIds
            : [pending.batchId];
        const allReady = ids.every(
          (id) => node.worker.dag.isReady(id) && node.worker.dag.getBody(id),
        );
        if (allReady) {
          const allTxs: BatchTx[] = [];
          for (const id of ids) {
            allTxs.push(...node.worker.dag.getBody(id)!);
          }
          let root: string | null;
          if (ids.length > 1 || pending.aggregateDigest) {
            try {
              root = parallelSafeScheduleApply(node.economic, allTxs).scheduledRoot;
            } catch {
              continue;
            }
          } else {
            root = node.economic.previewRoot(allTxs);
          }
          if (root === pending.stateRoot) {
            batchId = pending.batchId;
            stateRoot = pending.stateRoot;
            height = pending.height;
          }
        }
      }
      if (!batchId || !stateRoot) {
        for (const b of node.readyBatches) {
          const body = node.worker.dag.getBody(b);
          if (!body) continue;
          const root = node.economic.previewRoot(body);
          if (!root) continue;
          const header = node.worker.dag.getHeader(b);
          if (!header) continue;
          const pp: ProposalPayload = {
            batchId: b,
            txDigest: header.txDigest,
            stateRoot: root,
            epoch: this.epoch,
            height: pending?.height ?? header.height,
            previousStateRoot: node.economic.previousRoot(),
          };
          if (proposalDigestFromPayload(pp) === digest) {
            batchId = b;
            stateRoot = root;
            height = pp.height;
            break;
          }
        }
      }
      if (!batchId || !stateRoot) continue;

      const env = signEnvelope(leader.identity, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "lab-mn",
        domainId: 1,
        sequence: height,
        previousStateRoot: node.economic.previousRoot(),
        newStateRoot: stateRoot,
        transitionId: digest.slice(0, 32),
        nullifier: `NF-${batchId}`,
        transactionCommitment: node.worker.dag.getHeader(batchId)!.txDigest,
        ts: height,
      });
      const proposal = proposalFromEnvelope(env);
      // Force digest match by using board with actual votes' digest
      // Votes are on `digest` from proposalDigestFromPayload — envelope digest differs.
      // LAB: build synthetic proposal with required digest field via board register of votes only.
      const synthetic: TransitionProposal = {
        digest,
        networkId: "lab-mn",
        domainId: 1,
        leaderNodeId: leader.id,
        sequence: height,
        previousStateRoot: node.economic.previousRoot(),
        newStateRoot: stateRoot,
        nullifier: `NF-${batchId}`,
        transitionId: digest.slice(0, 32),
      };
      node.board.register(synthetic);
      const cert = assembleCommitCert(synthetic, [...byVoter.values()]);
      const candidates = this.nodes.map((x) => x.id);
      const keys: Record<string, string> = {};
      for (const e of node.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        cert,
        candidates,
        (id) => keys[id],
        node.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) continue;

      node.commitCerts.set(digest, cert);
      node.stages.set(digest, "committed");
      this.stats.commits++;

      // broadcast COMMIT_CERT
      const cenv = sealConsensusMsg(
        node.identity,
        "COMMIT_CERT",
        this.epoch,
        height,
        {
          cert,
          batchId,
          batchIds: node.pendingProposals.get(digest)?.batchIds,
          stateRoot,
          epoch: this.epoch,
          height,
        },
      );
      this.net.broadcast(
        node.id,
        this.peers,
        "COMMIT_CERT",
        Buffer.from(JSON.stringify(cenv), "utf8"),
      );

      this.applyIfPossible(node, batchId, stateRoot, cert);

      // Finality cert
      const fc = buildFinalityCertificate(synthetic, cert, {
        networkId: "lab-mn",
        domainId: 1,
        epoch: this.epoch,
        finalizers: this.nodes.map((x) => x.identity),
      });
      const fenv = sealConsensusMsg(
        node.identity,
        "FINALITY_CERT",
        this.epoch,
        height,
        { cert: fc, batchId, stateRoot },
      );
      this.net.broadcast(
        node.id,
        this.peers,
        "FINALITY_CERT",
        Buffer.from(JSON.stringify(fenv), "utf8"),
      );
      node.finalityCerts.set(digest, fc);
      node.economic.markFinalized(batchId);
      const pend = node.pendingProposals.get(digest);
      if (pend?.batchIds) {
        for (const id of pend.batchIds) node.economic.markFinalized(id);
      }
      node.stages.set(digest, "finalized");
      this.stats.finalities++;
    }
  }

  private applyIfPossible(
    node: IndependentNode,
    batchId: string,
    expectedRoot: string,
    _cert: CommitCert,
  ): void {
    // Resolve aggregate batch set from pending proposal if present
    let ids = [batchId];
    for (const p of node.pendingProposals.values()) {
      if (
        p.batchId === batchId ||
        (p.batchIds && p.batchIds.includes(batchId))
      ) {
        if (p.batchIds && p.batchIds.length > 0) ids = p.batchIds;
        break;
      }
    }
    if (ids.every((id) => node.appliedBatches.has(id))) return;
    for (const id of ids) {
      if (!node.worker.dag.isReady(id)) return;
    }
    const allTxs: BatchTx[] = [];
    for (const id of ids) {
      const body = node.worker.dag.getBody(id);
      if (!body) return;
      allTxs.push(...body);
    }
    // S2-3 + S5-2 enforced inside applyTransfers when required / appliedTxIds
    for (const tx of allTxs) {
      const a = authorizeBatchTx(tx, this.authOpts());
      if (!a.ok) {
        this.stats.rejected++;
        return;
      }
    }
    try {
      if (ids.length > 1) {
        const plan = parallelSafeScheduleApply(node.economic, allTxs);
        for (const wave of plan.waves) {
          if (wave.length === 0) continue;
          const tr = node.economic.applyTransfers(wave);
          if (!tr.ok) {
            this.stats.rejected++;
            return;
          }
        }
        const root = node.economic.commitLogicalHeight();
        if (root !== expectedRoot) {
          this.stats.rejected++;
          return;
        }
      } else {
        const r = node.economic.applyBatch(allTxs);
        if (!r.ok || r.stateRoot !== expectedRoot) {
          this.stats.rejected++;
          return;
        }
      }
    } catch {
      this.stats.rejected++;
      return;
    }
    for (const id of ids) node.appliedBatches.add(id);
  }

  finalizedStateDigest(nodeId: string): string {
    const n = this.node(nodeId);
    return createHash("sha256")
      .update(
        [
          n.economic.stateRoot(),
          [...n.economic.finalizedBatchIds].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  stateRoot(nodeId: string): string {
    return this.node(nodeId).economic.stateRoot();
  }

  allHonestSameFinalState(): boolean {
    const honest = this.nodes.filter((n) => !n.byzantine);
    if (!honest.length) return true;
    const d0 = this.finalizedStateDigest(honest[0]!.id);
    return honest.every((n) => this.finalizedStateDigest(n.id) === d0);
  }

  allHonestSameStateRoot(): boolean {
    const honest = this.nodes.filter((n) => !n.byzantine);
    if (!honest.length) return true;
    const r0 = this.stateRoot(honest[0]!.id);
    return honest.every((n) => this.stateRoot(n.id) === r0);
  }

  anyConflictingFinality(): boolean {
    const roots = new Set<string>();
    for (const n of this.nodes) {
      if (n.byzantine) continue;
      for (const fc of n.finalityCerts.values()) {
        roots.add(fc.stateRoot);
      }
    }
    return roots.size > 1;
  }

  dagDigest(nodeId: string): string {
    const n = this.node(nodeId);
    return createHash("sha256")
      .update([...n.readyBatches].sort().join(","))
      .digest("hex");
  }

  allHonestDagConverged(): boolean {
    const honest = this.nodes.filter((n) => !n.byzantine);
    if (!honest.length) return true;
    const d0 = this.dagDigest(honest[0]!.id);
    return honest.every((n) => this.dagDigest(n.id) === d0);
  }

  allHonestConverged(): boolean {
    return this.allHonestSameFinalState();
  }
}
