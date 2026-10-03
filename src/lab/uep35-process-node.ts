/**
 * UEP-35.9 — One OS process = one consensus node.
 * Control plane: JSON lines on stdin/stdout.
 * Data plane: TCP mesh (uep35-tcp-mesh).
 *
 * Env:
 *   UEP_NODE_ID=mn-0
 *   UEP_NODE_INDEX=0
 *   UEP_BOOTSTRAP=/path/to/bootstrap.json
 */

import {
  createNodeIdentity,
  NodeRegistry,
  registryFromIdentity,
  type NodeIdentity,
} from "./node-identity.ts";
import { UepWorker } from "./uep35-worker.ts";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { SmtEconomicState, type LeafMode } from "./uep37-smt-economic-state.ts";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
import {
  sealConsensusMsg,
  verifyConsensusMsg,
  proposalDigestFromPayload,
  type ProposalPayload,
  type ConsensusEnvelope,
} from "./uep35-consensus-msg.ts";
import {
  signCommitVote,
  assembleCommitCert,
  verifyCommitCert,
  ProposalBoard,
  type TransitionProposal,
  type CommitVote,
  type CommitCert,
} from "./uep34-commit-cert.ts";
import {
  buildFinalityCertificate,
  type FinalityCertificate,
} from "./uep35-finality.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { authorizeBatchTx } from "./uep-tx-auth.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import {
  isScheduledLeader,
  scheduledLeader,
  type ViewChangeReason,
} from "./uep37-leader-schedule.ts";
import {
  signViewChangeVote,
  assembleViewChangeQC,
  verifyViewChangeQC,
  canAdoptViewChangeQC,
  viewChangeTargetDigest,
  type ViewChangeTarget,
  type ViewChangeVote,
  type ViewChangeQC,
} from "./uep37-view-change-qc.ts";
import { buildDigestAggregate } from "./uep36-digest-agg.ts";
import {
  HeightVoteLock,
  ProposalTracker,
  validateProposalSemantics,
  previousRootMatches,
  assertAggregateDigestBinding,
} from "./uep36-aggregate-semantics.ts";
import type { DagBatchHeader } from "./uep35-dag.ts";
import { verifyArtifactAgainstRoots } from "./uep38-node-verify.ts";
import { deserializeStagingArtifact } from "./uep38-p4-staging.ts";
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";

export type BootstrapNode = {
  id: string;
  index: number;
  /** SPKI public key hex */
  publicKeyHex: string;
  /** PKCS8 private key hex — only for this process node */
  privateKeyHex?: string;
  dataPort?: number;
};

export type BootstrapFile = {
  networkId: string;
  domainId: number;
  epoch: number;
  nodes: BootstrapNode[];
  balances: Record<string, string>;
};

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

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

function identityFromHex(nodeId: string, privateKeyHex: string, publicKeyHex: string): NodeIdentity {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    type: "pkcs8",
    format: "der",
  });
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyHex, "hex"),
    type: "spki",
    format: "der",
  });
  return { nodeId, privateKey, publicKey, publicKeyHex };
}


/** Write bootstrap for a single node: only that node's private key is present. */
export function bootstrapForNode(full: BootstrapFile, nodeId: string): BootstrapFile {
  return {
    ...full,
    nodes: full.nodes.map((n) =>
      n.id === nodeId
        ? n
        : { id: n.id, index: n.index, publicKeyHex: n.publicKeyHex, dataPort: n.dataPort },
    ),
  };
}

export function generateBootstrap(n: number): BootstrapFile {
  const nodes: BootstrapNode[] = [];
  for (let i = 0; i < n; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    const privateKeyHex = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
    nodes.push({
      id: `mn-${i}`,
      index: i,
      publicKeyHex,
      privateKeyHex,
    });
  }
  return {
    networkId: "lab-mn",
    domainId: 1,
    epoch: 0,
    nodes,
    balances: {
      s0: "100000",
      s1: "100000",
      s2: "100000",
      r0: "0",
      r1: "0",
      r2: "0",
      r3: "0",
    },
  };
}

class ProcessNodeRuntime {
  identity!: NodeIdentity;
  registry = new NodeRegistry();
  worker!: UepWorker;
  economic!: LocalEconomicState | SmtEconomicState;
  mesh!: TcpMeshEndpoint;
  board = new ProposalBoard();
  votes = new Map<string, CommitVote[]>();
  seenMsgIds = new Set<string>();
  seenVotes = new Set<string>();
  voteLock = new HeightVoteLock();
  proposalTracker = new ProposalTracker();
  commitCerts = new Map<string, CommitCert>();
  finalityCerts = new Map<string, FinalityCertificate>();
  readyBatches = new Set<string>();
  pendingProposals = new Map<string, ProposalPayload>();
  appliedBatches = new Set<string>();
  epoch = 0;
  globalSeq = 0;
  /** UEP-37.7 process-mesh view */
  heightView = 0;
  leaderTimeoutMs = 0;
  lastProgressAt = Date.now();
  viewChangeLog: Array<{ height: number; view: number; reason: string }> = [];
  /** Pending votes keyed by targetDigest */
  viewChangeVotes = new Map<string, ViewChangeVote[]>();
  adoptedViewQcDigests = new Set<string>();
  peerPorts = new Map<string, number>();
  peerHosts = new Map<string, string>();
  /** last known peer list for heal reconnect */
  lastPeers: Array<{ id: string; port: number; host?: string }> = [];
  bootstrap!: BootstrapFile;
  nodeId = "";
  /** K-2: mirror MultiNodeCluster auth (env UEP_REQUIRE_TX_AUTH=1) */
  requireTxAuth = false;
  accountKeys: Record<string, string> = {};

  async init(bootstrapPath: string, nodeId: string): Promise<void> {
    this.bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8")) as BootstrapFile;
    this.nodeId = nodeId;
    const self = this.bootstrap.nodes.find((n) => n.id === nodeId);
    if (!self?.privateKeyHex) throw new Error("missing private key for node");
    this.identity = identityFromHex(nodeId, self.privateKeyHex, self.publicKeyHex);
    for (const n of this.bootstrap.nodes) {
      this.registry.register({
        nodeId: n.id,
        publicKeyHex: n.publicKeyHex,
        networkId: this.bootstrap.networkId,
        domainId: this.bootstrap.domainId,
        role: "replica",
        status: "active",
      });
    }
    const balances: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(this.bootstrap.balances)) {
      balances[k] = BigInt(v);
    }
    const leafMode = (process.env.UEP_LEAF_MODE ?? "local") as string;
    const smtDepth = process.env.UEP_SMT_DEPTH
      ? Number(process.env.UEP_SMT_DEPTH)
      : undefined;
    if (leafMode === "poseidon-zk" || leafMode === "structural") {
      this.economic = SmtEconomicState.genesis(balances, {
        leafMode: leafMode as LeafMode,
        ...(smtDepth !== undefined && smtDepth !== 32
          ? { testOnlyDepth: smtDepth, isTestFixture: true }
          : {}),
      });
    } else {
      this.economic = new LocalEconomicState(balances);
    }
    this.worker = new UepWorker({
      workerId: nodeId,
      epoch: this.bootstrap.epoch,
      identity: this.identity,
      mempool: { maxBatchSize: 64, maxBatchBytes: 100_000, maxPending: 10_000 },
    });
    this.epoch = this.bootstrap.epoch;
    this.leaderTimeoutMs = Number(process.env.UEP_LEADER_TIMEOUT_MS ?? "0") || 0;
    this.requireTxAuth = process.env.UEP_REQUIRE_TX_AUTH === "1" || process.env.UEP_REQUIRE_TX_AUTH === "true";
    const keysEnv = process.env.UEP_ACCOUNT_KEYS_JSON;
    if (keysEnv) {
      try {
        this.accountKeys = JSON.parse(keysEnv) as Record<string, string>;
      } catch {
        /* ignore */
      }
    }
    this.lastProgressAt = Date.now();
    this.mesh = new TcpMeshEndpoint(nodeId);
    this.mesh.onMessage((from, kind, payload) => this.onNet(from, kind, payload));
    const bindHost = process.env.UEP_BIND_HOST ?? "127.0.0.1";
    const port = await this.mesh.listen(bindHost, self.dataPort ?? 0);
    emit({ event: "ready", nodeId, port });
  }

  async connectPeers(peers: Array<{ id: string; port: number; host?: string }>): Promise<void> {
    this.lastPeers = peers;
    for (const p of peers) {
      if (p.id === this.nodeId) continue;
      this.peerPorts.set(p.id, p.port);
      const host = p.host ?? "127.0.0.1";
      this.peerHosts.set(p.id, host);
      await this.mesh.connectPeer(p.id, host, p.port);
    }
    await new Promise((r) => setTimeout(r, 50));
    emit({ event: "connected", peers: this.mesh.peerIds() });
  }

  /** UEP-35.11 — block traffic to/from listed peers (logical partition). */
  setPartition(blockedPeerIds: string[]): void {
    this.mesh.clearBlocks();
    for (const id of blockedPeerIds) {
      if (id !== this.nodeId) this.mesh.blockPeer(id);
    }
    emit({ event: "partitioned", blocked: this.mesh.blockedPeers() });
  }

  healPartition(): void {
    this.mesh.clearBlocks();
    emit({ event: "healed", blocked: [] });
  }

  /**
   * After heal: rebroadcast known commit/finality certs so lagging peers catch up.
   * Does not invent new state — only re-sends certificates already verified locally.
   */
  resyncCerts(): void {
    // 1) Rebroadcast proposals so lagging peers recover aggregate batchIds
    for (const [digest, pend] of this.pendingProposals) {
      const env = sealConsensusMsg(
        this.identity,
        "PROPOSAL",
        this.epoch,
        pend.height,
        pend,
      );
      this.mesh.broadcast("PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    }
    // 2) Commit certs with batchIds for aggregate apply
    for (const [digest, cert] of this.commitCerts) {
      const pend = this.pendingProposals.get(digest);
      const batchId = pend?.batchId ?? [...this.appliedBatches][0] ?? "";
      const batchIds = pend?.batchIds;
      const stateRoot = cert.proposal.newStateRoot;
      this.mesh.broadcast(
        "COMMIT_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(this.identity, "COMMIT_CERT", this.epoch, cert.proposal.sequence, {
              cert,
              batchId,
              batchIds,
              stateRoot,
              epoch: this.epoch,
              height: cert.proposal.sequence,
            }),
          ),
          "utf8",
        ),
      );
    }
    for (const [digest, fc] of this.finalityCerts) {
      const pend = this.pendingProposals.get(digest);
      const batchId = pend?.batchId ?? [...this.economic.finalizedBatchIds][0] ?? "";
      this.mesh.broadcast(
        "FINALITY_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(this.identity, "FINALITY_CERT", this.epoch, fc.sequence, {
              cert: fc,
              batchId,
              batchIds: pend?.batchIds,
              stateRoot: fc.stateRoot,
            }),
          ),
          "utf8",
        ),
      );
    }
    // 3) Headers/bodies for recovery
    for (const batchId of this.readyBatches) {
      const header = this.worker.dag.getHeader(batchId);
      const body = this.worker.dag.getBody(batchId);
      if (header) {
        this.mesh.broadcast(
          "BATCH_HEADER",
          Buffer.from(JSON.stringify(header), "utf8"),
        );
      }
      if (header && body) {
        this.mesh.broadcast(
          "BATCH_BODY",
          Buffer.from(
            JSON.stringify({
              batchId,
              txs: body.map((tx) => ({
                id: tx.id,
                from: tx.from,
                to: tx.to,
                amount: tx.amount.toString(),
              })),
            }),
            "utf8",
          ),
        );
      }
    }
    emit({
      event: "resync",
      commits: this.commitCerts.size,
      finals: this.finalityCerts.size,
      ready: this.readyBatches.size,
    });
  }

  filterAuthorizedTxs(txs: BatchTx[]): BatchTx[] {
    if (!this.requireTxAuth) return txs;
    const out: BatchTx[] = [];
    for (const tx of txs) {
      const a = authorizeBatchTx(tx, {
        requireAuth: true,
        requireAccountKeyBinding: true,
        accountKeys: this.accountKeys,
      });
      if (a.ok) out.push(tx);
    }
    return out;
  }

  async propose(txs: BatchTx[]): Promise<void> {
    if (!this.mayPropose()) {
      emit({
        event: "error",
        reason: "NOT_LEADER",
        leader: this.currentLeader(),
        heightView: this.heightView,
        height: this.nextHeight(),
      });
      return;
    }
    const viable = this.filterAuthorizedTxs(txs);
    if (viable.length === 0) {
      emit({ event: "error", reason: "AUTH_OR_EMPTY" });
      return;
    }
    for (const tx of viable) this.worker.admit(tx);
    const produced = this.worker.produceBatch();
    if (!produced) {
      emit({ event: "error", reason: "NO_BATCH" });
      return;
    }
    this.readyBatches.add(produced.header.batchId);
    this.mesh.broadcast(
      "BATCH_HEADER",
      Buffer.from(encodeHeader(produced.header), "utf8"),
    );
    this.mesh.broadcast(
      "BATCH_BODY",
      Buffer.from(encodeBody(produced.header.batchId, produced.txs), "utf8"),
    );
    const stateRoot = this.economic.previewRoot(produced.txs);
    if (!stateRoot) {
      emit({ event: "error", reason: "PREVIEW_FAIL" });
      return;
    }
    let economicCommitment: string | undefined;
    try {
      const tipProbe = this.economic.clone();
      const tr = tipProbe.applyTransfers(produced.txs);
      if (tr.ok) {
        tipProbe.commitLogicalHeight();
        if (typeof (tipProbe as { economicTipCommitment?: () => string }).economicTipCommitment === "function") {
          economicCommitment = (tipProbe as { economicTipCommitment: () => string }).economicTipCommitment();
        }
      }
    } catch {
      /* tip optional if clone fails */
    }
    this.globalSeq += 1;
    const propPayload: ProposalPayload = {
      batchId: produced.header.batchId,
      txDigest: produced.header.txDigest,
      stateRoot,
      epoch: this.epoch,
      height: this.globalSeq,
      previousStateRoot: this.economic.previousRoot(),
      ...(economicCommitment ? { economicCommitment } : {}),
    };
    const env = sealConsensusMsg(
      this.identity,
      "PROPOSAL",
      this.epoch,
      propPayload.height,
      propPayload,
    );
    this.mesh.broadcast("PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    const digest = proposalDigestFromPayload(propPayload);
    this.pendingProposals.set(digest, propPayload);
    this.tryVote(digest, propPayload);
    emit({
      event: "proposed",
      batchId: produced.header.batchId,
      proposalDigest: digest,
      stateRoot,
    });
  }


  scheduleNodeIds(): string[] {
    return this.bootstrap.nodes.map((n) => n.id);
  }

  nextHeight(): number {
    return this.economic.sequence + 1;
  }

  currentLeader(): string {
    return scheduledLeader(this.nextHeight(), this.scheduleNodeIds(), this.heightView);
  }

  mayPropose(): boolean {
    return isScheduledLeader(
      this.nodeId,
      this.nextHeight(),
      this.scheduleNodeIds(),
      this.heightView,
    );
  }

  buildViewChangeTarget(reason: ViewChangeReason | string): ViewChangeTarget {
    return {
      networkId: this.bootstrap.networkId,
      domainId: this.bootstrap.domainId,
      epoch: this.epoch,
      height: this.nextHeight(),
      nextView: this.heightView + 1,
      reason,
    };
  }

  /**
   * UEP-37.7.2 — Propose a view-change *vote* (does NOT adopt the view).
   * Adoption happens only when a ViewChangeQC with quorum is verified.
   */
  requestViewChange(reason: ViewChangeReason = "MANUAL"): void {
    const target = this.buildViewChangeTarget(reason);
    const vote = signViewChangeVote(this.identity, target);
    this.ingestViewChangeVote(target, vote);
    this.mesh.broadcast(
      "VIEW_CHANGE_VOTE",
      Buffer.from(JSON.stringify({ target, vote }), "utf8"),
    );
    emit({
      event: "view-change-vote",
      height: target.height,
      nextView: target.nextView,
      targetDigest: vote.targetDigest,
      from: this.nodeId,
    });
  }

  /** @deprecated name kept for CLI; now only emits a vote, no optimistic adopt */
  advanceViewLocal(reason: ViewChangeReason = "MANUAL"): void {
    this.requestViewChange(reason);
  }

  noteProgress(): void {
    this.heightView = 0;
    this.lastProgressAt = Date.now();
    this.viewChangeVotes.clear();
  }

  checkSilentLeaderTimeout(): void {
    if (this.leaderTimeoutMs <= 0) return;
    if (Date.now() - this.lastProgressAt < this.leaderTimeoutMs) return;
    this.requestViewChange("SILENT_LEADER_TIMEOUT");
    // prevent spam: push lastProgress slightly (votes may still arrive)
    this.lastProgressAt = Date.now();
  }

  private publicKeyOf(nodeId: string): string | undefined {
    return this.registry.publicKeyHex(nodeId);
  }

  private ingestViewChangeVote(target: ViewChangeTarget, vote: ViewChangeVote): void {
    const digest = viewChangeTargetDigest(target);
    if (vote.targetDigest !== digest) return;
    // Must match our network identity and next height; nextView must be exactly local+1
    // (no skip-ahead without intermediate QCs).
    if (target.networkId !== this.bootstrap.networkId) return;
    if (target.domainId !== this.bootstrap.domainId) return;
    if (target.epoch !== this.epoch) return;
    if (target.height !== this.nextHeight()) return;
    if (target.nextView !== this.heightView + 1) return;

    const pk = this.publicKeyOf(vote.nodeId);
    if (!pk) return;

    let list = this.viewChangeVotes.get(digest) ?? [];
    if (!list.some((v) => v.nodeId === vote.nodeId)) {
      list.push(vote);
      this.viewChangeVotes.set(digest, list);
    }

    // Co-sign: honest replicas endorse the same target so QC can form.
    if (!list.some((v) => v.nodeId === this.nodeId)) {
      const selfVote = signViewChangeVote(this.identity, target);
      list = [...list, selfVote];
      this.viewChangeVotes.set(digest, list);
      this.mesh.broadcast(
        "VIEW_CHANGE_VOTE",
        Buffer.from(JSON.stringify({ target, vote: selfVote }), "utf8"),
      );
    }

    const ids = this.scheduleNodeIds();
    const assembled = assembleViewChangeQC(target, list, ids, (id) => this.publicKeyOf(id));
    if (!assembled.ok) return;
    this.broadcastAndAdoptQc(assembled.qc);
  }

  private broadcastAndAdoptQc(qc: ViewChangeQC): void {
    if (this.adoptedViewQcDigests.has(qc.targetDigest)) return;
    this.mesh.broadcast(
      "VIEW_CHANGE_QC",
      Buffer.from(JSON.stringify(qc), "utf8"),
    );
    this.tryAdoptViewChangeQC(qc);
  }

  private tryAdoptViewChangeQC(qc: ViewChangeQC): void {
    const ids = this.scheduleNodeIds();
    const vr = verifyViewChangeQC(qc, ids, (id) => this.publicKeyOf(id), {
      networkId: this.bootstrap.networkId,
      domainId: this.bootstrap.domainId,
      epoch: this.epoch,
      height: this.nextHeight(),
    });
    if (!vr.ok) {
      emit({ event: "view-change-qc-rejected", reason: vr.reason });
      return;
    }
    const adopt = canAdoptViewChangeQC(qc, {
      height: this.nextHeight(),
      heightView: this.heightView,
      networkId: this.bootstrap.networkId,
      domainId: this.bootstrap.domainId,
      epoch: this.epoch,
    });
    if (!adopt.ok) {
      emit({ event: "view-change-qc-rejected", reason: adopt.reason });
      return;
    }
    this.adoptedViewQcDigests.add(qc.targetDigest);
    this.heightView = qc.target.nextView;
    this.lastProgressAt = Date.now();
    this.viewChangeLog.push({
      height: qc.target.height,
      view: this.heightView,
      reason: String(qc.target.reason),
    });
    emit({
      event: "view-changed",
      height: qc.target.height,
      view: this.heightView,
      reason: qc.target.reason,
      leader: this.currentLeader(),
      qcVotes: qc.votes.length,
      via: "VIEW_CHANGE_QC",
    });
  }

  async proposeAggregate(batches: BatchTx[][]): Promise<void> {
    if (batches.length === 0) {
      emit({ event: "error", reason: "EMPTY_AGGREGATE" });
      return;
    }
    if (!this.mayPropose()) {
      emit({
        event: "error",
        reason: "NOT_LEADER",
        leader: this.currentLeader(),
        heightView: this.heightView,
        height: this.nextHeight(),
      });
      return;
    }
    const producedList: { batchId: string; txDigest: string; txs: BatchTx[] }[] = [];
    for (const txs of batches) {
      const viable = this.filterAuthorizedTxs(txs);
      if (viable.length === 0) continue;
      for (const tx of viable) this.worker.admit(tx);
      const produced = this.worker.produceBatch();
      if (!produced) {
        emit({ event: "error", reason: "NO_BATCH" });
        return;
      }
      producedList.push({
        batchId: produced.header.batchId,
        txDigest: produced.header.txDigest,
        txs: produced.txs,
      });
      this.readyBatches.add(produced.header.batchId);
      this.mesh.broadcast(
        "BATCH_HEADER",
        Buffer.from(encodeHeader(produced.header), "utf8"),
      );
      this.mesh.broadcast(
        "BATCH_BODY",
        Buffer.from(encodeBody(produced.header.batchId, produced.txs), "utf8"),
      );
    }
    const prev = this.economic.previousRoot();
    const allTxs: BatchTx[] = [];
    for (const p of producedList) allTxs.push(...p.txs);
    const exec = parallelSafeScheduleApply(this.economic, allTxs);
    if (!exec.fullStateEqual) {
      emit({ event: "error", reason: "EXEC_DIVERGENCE" });
      return;
    }
    const stateRoot = exec.scheduledRoot;
    let economicCommitment: string | undefined;
    try {
      const tipProbe = this.economic.clone();
      const tr = tipProbe.applyTransfers(allTxs);
      if (tr.ok) {
        tipProbe.commitLogicalHeight();
        if (typeof (tipProbe as { economicTipCommitment?: () => string }).economicTipCommitment === "function") {
          economicCommitment = (tipProbe as { economicTipCommitment: () => string }).economicTipCommitment();
        }
      }
    } catch {
      /* ignore */
    }
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
    const env = sealConsensusMsg(
      this.identity,
      "PROPOSAL",
      this.epoch,
      height,
      propPayload,
    );
    this.mesh.broadcast("PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    const digest = proposalDigestFromPayload(propPayload);
    this.pendingProposals.set(digest, propPayload);
    this.tryVote(digest, propPayload);
    emit({
      event: "proposed",
      batchId: batchIds[0],
      batchIds,
      aggregateDigest: agg.aggregateDigest,
      proposalDigest: digest,
      stateRoot,
    });
  }


  status(): void {
    const tip =
      typeof (this.economic as { economicTipCommitment?: () => string })
        .economicTipCommitment === "function"
        ? (this.economic as { economicTipCommitment: () => string }).economicTipCommitment()
        : this.economic.stateRoot();
    const balances = this.economic.balancesSnapshot();
    emit({
      event: "status",
      nodeId: this.nodeId,
      stateRoot: this.economic.stateRoot(),
      economicTip: tip,
      sequence: this.economic.sequence,
      treasury: this.economic.treasuryBalance.toString(),
      balances,
      finalized: [...this.economic.finalizedBatchIds],
      ready: [...this.readyBatches],
      peers: this.mesh.peerIds(),
      blocked: this.mesh.blockedPeers(),
      votes: this.votes.size,
      commits: this.commitCerts.size,
      finalities: this.finalityCerts.size,
      heightView: this.heightView,
      leader: this.currentLeader(),
      nextHeight: this.nextHeight(),
    });
  }

  tickAssemble(): void {
    this.checkSilentLeaderTimeout();
    this.tryAssemble();
  }

  private onNet(from: string, kind: string, payload: Uint8Array): void {
    const text = Buffer.from(payload).toString("utf8");
    if (kind === "VIEW_CHANGE_VOTE") {
      try {
        const body = JSON.parse(text) as {
          target: ViewChangeTarget;
          vote: ViewChangeVote;
        };
        this.ingestViewChangeVote(body.target, body.vote);
      } catch {
        /* ignore */
      }
      return;
    }
    if (kind === "VIEW_CHANGE_QC") {
      try {
        const qc = JSON.parse(text) as ViewChangeQC;
        this.tryAdoptViewChangeQC(qc);
      } catch {
        /* ignore */
      }
      return;
    }
    // Legacy optimistic VIEW_CHANGE is intentionally ignored (37.7.2).
    if (kind === "VIEW_CHANGE") {
      emit({ event: "view-change-ignored", reason: "REQUIRES_QC" });
      return;
    }
    if (kind === "BATCH_HEADER") {
      const h = decodeHeader(text);
      if (!this.worker.announceHeader(h, true, this.registry).ok) return;
      if (!this.worker.dag.hasBody(h.batchId)) {
        this.mesh.send(
          from,
          "BATCH_BODY_REQ",
          Buffer.from(JSON.stringify({ batchId: h.batchId }), "utf8"),
        );
      }
      return;
    }
    if (kind === "BATCH_BODY_REQ") {
      const { batchId } = JSON.parse(text) as { batchId: string };
      const body = this.worker.dag.getBody(batchId);
      if (!body) return;
      this.mesh.send(
        from,
        "BATCH_BODY",
        Buffer.from(encodeBody(batchId, body), "utf8"),
      );
      return;
    }
    if (kind === "BATCH_BODY") {
      const { batchId, txs } = decodeBody(text);
      const header = this.worker.dag.getHeader(batchId);
      if (!header) return;
      if (
        this.worker.ingestRecovery(header, txs).ok &&
        this.worker.dag.isReady(batchId)
      ) {
        this.readyBatches.add(batchId);
        for (const [digest, p] of this.pendingProposals) {
          const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
          if (ids.includes(batchId)) this.tryVote(digest, p);
        }
      }
      return;
    }
    if (
      kind === "PROPOSAL" ||
      kind === "VOTE" ||
      kind === "COMMIT_CERT" ||
      kind === "FINALITY_CERT"
    ) {
      try {
        this.handleConsensus(JSON.parse(text) as ConsensusEnvelope);
      } catch {
        /* ignore */
      }
    }
  }

  private handleConsensus(env: ConsensusEnvelope): void {
    if (this.seenMsgIds.has(env.msgId)) return;
    const pk = this.registry.publicKeyHex(env.sender);
    if (!pk || !this.registry.isActive(env.sender)) return;
    if (!verifyConsensusMsg(env, pk)) return;
    this.seenMsgIds.add(env.msgId);

    if (env.type === "PROPOSAL") {
      const p = JSON.parse(env.payload) as ProposalPayload;
      const sem = validateProposalSemantics(p);
      if (!sem.ok) return;
      if (!assertAggregateDigestBinding(p).ok) return;
      const digest = proposalDigestFromPayload(p);
      const obs = this.proposalTracker.observe(env.sender, p.epoch, p.height, digest);
      if (obs.equivocation) {
        this.voteLock.noteConflictingProposals(
          p.epoch,
          p.height,
          obs.digests[0]!,
          obs.digests[1]!,
          env.sender,
        );
        const locked = this.voteLock.get(p.epoch, p.height);
        if (locked && locked !== digest) {
          this.pendingProposals.set(digest, p);
          return;
        }
      }
      this.pendingProposals.set(digest, p);
      if (typeof p.height === "number" && p.height > this.globalSeq) {
        this.globalSeq = p.height;
      }
      this.tryVote(digest, p);
      return;
    }
    if (env.type === "VOTE") {
      const v = JSON.parse(env.payload) as {
        proposalDigest: string;
        commitSig: string;
      };
      const voteKey = `${env.sender}|${v.proposalDigest}`;
      if (this.seenVotes.has(voteKey)) return;
      this.seenVotes.add(voteKey);
      const vote: CommitVote = {
        nodeId: env.sender,
        proposalDigest: v.proposalDigest,
        signature: v.commitSig,
      };
      const list = this.votes.get(v.proposalDigest) ?? [];
      list.push(vote);
      this.votes.set(v.proposalDigest, list);
      return;
    }
    if (env.type === "COMMIT_CERT") {
      const payload = JSON.parse(env.payload) as {
        cert: CommitCert;
        batchId: string;
        stateRoot: string;
      };
      if (payload.cert.proposal.newStateRoot !== payload.stateRoot) return;
      this.board.register(payload.cert.proposal);
      const keys: Record<string, string> = {};
      for (const e of this.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        payload.cert,
        this.bootstrap.nodes.map((n) => n.id),
        (id) => keys[id],
        this.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) return;
      this.commitCerts.set(payload.cert.proposal.digest, payload.cert);
      {
        let pend = this.pendingProposals.get(payload.cert.proposal.digest);
        const payloadAny = payload as {
          batchId: string;
          batchIds?: string[];
          stateRoot: string;
        };
        if (!pend && payloadAny.batchIds && payloadAny.batchIds.length > 0) {
          // Reconstruct minimal pending for aggregate apply after catch-up
          pend = {
            batchId: payloadAny.batchId,
            txDigest: "",
            stateRoot: payloadAny.stateRoot,
            epoch: this.epoch,
            height: payload.cert.proposal.sequence,
            previousStateRoot: payload.cert.proposal.previousStateRoot,
            batchIds: payloadAny.batchIds,
            aggregateDigest: payload.cert.proposal.transitionId,
          };
          this.pendingProposals.set(payload.cert.proposal.digest, pend);
        }
        if (pend) {
          this.applyProposalBatches(pend, payload.stateRoot);
        } else if (!this.appliedBatches.has(payload.batchId)) {
          const body = this.worker.dag.getBody(payload.batchId);
          if (body) {
            const r = this.economic.applyBatch(body);
            if (r.ok && r.stateRoot === payload.stateRoot) {
              this.appliedBatches.add(payload.batchId);
            }
          }
        }
      }
      return;
    }
    if (env.type === "FINALITY_CERT") {
      const payload = JSON.parse(env.payload) as {
        cert: FinalityCertificate;
        batchId: string;
        stateRoot: string;
      };
      if (payload.cert.stateRoot !== payload.stateRoot) return;
      if (this.economic.isFinalized(payload.batchId)) return;
      // must verify embedded CommitCert (not trust FINALITY alone)
      this.board.register(payload.cert.commitCert.proposal);
      const keys: Record<string, string> = {};
      for (const e of this.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        payload.cert.commitCert,
        this.bootstrap.nodes.map((n) => n.id),
        (id) => keys[id],
        this.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) return;
      if (payload.cert.commitCert.proposal.newStateRoot !== payload.stateRoot) return;
      // Must have applied economic transition before marking final
      {
        const pend = this.pendingProposals.get(payload.cert.proposalDigest);
        if (pend) {
          if (!this.applyProposalBatches(pend, payload.stateRoot)) return;
        } else if (!this.appliedBatches.has(payload.batchId)) {
          const body = this.worker.dag.getBody(payload.batchId);
          if (!body) return;
          const r = this.economic.applyBatch(body);
          if (!r.ok || r.stateRoot !== payload.stateRoot) return;
          this.appliedBatches.add(payload.batchId);
        }
      }
      if (this.economic.stateRoot() !== payload.stateRoot) return;
      this.finalityCerts.set(payload.cert.proposalDigest, payload.cert);
      this.economic.markFinalized(payload.batchId);
      const pendF = this.pendingProposals.get(payload.cert.proposalDigest);
      if (pendF?.batchIds) {
        for (const id of pendF.batchIds) this.economic.markFinalized(id);
      }
      this.noteProgress();
      emit({
        event: "finalized",
        batchId: payload.batchId,
        stateRoot: this.economic.stateRoot(),
      });
    }
  }

  private expectedRootForProposal(p: ProposalPayload): string | null {
    const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
    for (const id of ids) {
      if (!this.worker.dag.isReady(id) || !this.worker.dag.getBody(id)) return null;
    }
    const allTxs: BatchTx[] = [];
    for (const id of ids) allTxs.push(...this.worker.dag.getBody(id)!);
    try {
      if (ids.length > 1 || p.aggregateDigest) {
        return parallelSafeScheduleApply(this.economic, allTxs).scheduledRoot;
      }
      return this.economic.previewRoot(allTxs);
    } catch {
      return null;
    }
  }

  private applyProposalBatches(p: ProposalPayload, expectedRoot: string): boolean {
    const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
    if (ids.every((id) => this.appliedBatches.has(id))) {
      return this.economic.stateRoot() === expectedRoot;
    }
    for (const id of ids) {
      if (!this.worker.dag.isReady(id)) return false;
    }
    const allTxs: BatchTx[] = [];
    for (const id of ids) {
      const body = this.worker.dag.getBody(id);
      if (!body) return false;
      allTxs.push(...body);
    }
    try {
      if (ids.length > 1 || p.aggregateDigest) {
        const plan = parallelSafeScheduleApply(this.economic, allTxs);
        for (const wave of plan.waves) {
          if (wave.length === 0) continue;
          const tr = this.economic.applyTransfers(wave);
          if (!tr.ok) return false;
        }
        const root = this.economic.commitLogicalHeight();
        if (root !== expectedRoot) return false;
      } else {
        const r = this.economic.applyBatch(allTxs);
        if (!r.ok || r.stateRoot !== expectedRoot) return false;
      }
    } catch {
      return false;
    }
    for (const id of ids) this.appliedBatches.add(id);
    return true;
  }

  private tryVote(digest: string, p: ProposalPayload): void {
    // S1B-1: do not re-evaluate proposals already applied
    if (typeof p.height === "number" && p.height <= this.economic.sequence) return;
    let expected: string | null;
    try {
      expected = this.expectedRootForProposal(p);
    } catch {
      return;
    }
    if (expected === null || expected !== p.stateRoot) return;
    if (p.economicCommitment) {
      try {
        const ids = p.batchIds && p.batchIds.length > 0 ? p.batchIds : [p.batchId];
        const allTxs: BatchTx[] = [];
        for (const id of ids) {
          const body = this.worker.dag.getBody(id);
          if (!body) return;
          allTxs.push(...body);
        }
        const tipC = this.economic.clone();
        const tr = tipC.applyTransfers(allTxs);
        if (!tr.ok) return;
        tipC.commitLogicalHeight();
        const tip =
          typeof (tipC as { economicTipCommitment?: () => string }).economicTipCommitment ===
          "function"
            ? (tipC as { economicTipCommitment: () => string }).economicTipCommitment()
            : null;
        if (tip !== p.economicCommitment) return;
      } catch {
        return;
      }
    }
    if (process.env.UEP_REQUIRE_ZK_SPEND === "1" && !p.zkSpend) return;
    if (p.zkSpend) {
      try {
        const art = deserializeStagingArtifact(p.zkSpend);
        const oldRoot = this.economic.stateRoot();
        const chk = verifyArtifactAgainstRoots(art, oldRoot, p.stateRoot, ((this.economic as SmtEconomicState).depth ?? 4) as 4 | 32);
        if (!chk.ok) return;
      } catch {
        return;
      }
    }
    if (!previousRootMatches(this.economic.previousRoot(), p.previousStateRoot).ok) return;
    if (!this.voteLock.tryLock(p.epoch, p.height, digest).ok) return;
    if (this.seenVotes.has(`${this.nodeId}|${digest}`)) return;
    const vote = signCommitVote(this.identity, digest);
    const env = sealConsensusMsg(this.identity, "VOTE", this.epoch, p.height, {
      proposalDigest: digest,
      batchId: p.batchId,
      stateRoot: p.stateRoot,
      commitSig: vote.signature,
    });
    this.mesh.broadcast("VOTE", Buffer.from(JSON.stringify(env), "utf8"));
    const list = this.votes.get(digest) ?? [];
    list.push(vote);
    this.votes.set(digest, list);
    this.seenVotes.add(`${this.nodeId}|${digest}`);
  }

  private tryAssemble(): void {
    const n = this.bootstrap.nodes.length;
    const gate = assertBftConfig(n, "BFT-CLASSIC");
    if (!gate.ok) return;
    const need = gate.params.quorum;
    for (const [digest, votes] of this.votes) {
      if (this.commitCerts.has(digest)) continue;
      const byVoter = new Map<string, CommitVote>();
      for (const v of votes) byVoter.set(v.nodeId, v);
      if (byVoter.size < need) continue;
      let batchId: string | null = null;
      let stateRoot: string | null = null;
      let height = 0;
      const pending = this.pendingProposals.get(digest);
      if (pending && proposalDigestFromPayload(pending) === digest) {
        const root = this.expectedRootForProposal(pending);
        if (root === pending.stateRoot) {
          batchId = pending.batchId;
          stateRoot = pending.stateRoot;
          height = pending.height;
        }
      }
      if (!batchId || !stateRoot) {
        for (const b of this.readyBatches) {
          const body = this.worker.dag.getBody(b);
          const header = this.worker.dag.getHeader(b);
          if (!body || !header) continue;
          const root = this.economic.previewRoot(body);
          if (!root) continue;
          const pp: ProposalPayload = {
            batchId: b,
            txDigest: header.txDigest,
            stateRoot: root,
            epoch: this.epoch,
            height: pending?.height ?? header.height,
            previousStateRoot: this.economic.previousRoot(),
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
      const synthetic: TransitionProposal = {
        digest,
        networkId: this.bootstrap.networkId,
        domainId: this.bootstrap.domainId,
        leaderNodeId: this.bootstrap.nodes[0]!.id,
        sequence: height,
        previousStateRoot: this.economic.previousRoot(),
        newStateRoot: stateRoot,
        nullifier: `NF-${batchId}`,
        transitionId: digest.slice(0, 32),
      };
      this.board.register(synthetic);
      const cert = assembleCommitCert(synthetic, [...byVoter.values()]);
      const keys: Record<string, string> = {};
      for (const e of this.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        cert,
        this.bootstrap.nodes.map((x) => x.id),
        (id) => keys[id],
        this.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) continue;
      this.commitCerts.set(digest, cert);
      {
        const pendA = this.pendingProposals.get(digest);
        if (pendA) {
          if (!this.applyProposalBatches(pendA, stateRoot)) continue;
        } else if (!this.appliedBatches.has(batchId)) {
          const body = this.worker.dag.getBody(batchId);
          if (!body) continue;
          const r = this.economic.applyBatch(body);
          if (r.ok && r.stateRoot === stateRoot) this.appliedBatches.add(batchId);
        }
      }
      this.mesh.broadcast(
        "COMMIT_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(this.identity, "COMMIT_CERT", this.epoch, height, {
              cert,
              batchId,
              batchIds: this.pendingProposals.get(digest)?.batchIds,
              stateRoot,
              epoch: this.epoch,
              height,
            }),
          ),
          "utf8",
        ),
      );
      const finalizers = this.bootstrap.nodes.map((bn) => {
        // only we have our private key; finality votes from all nodes need identities —
        // LAB: only self signs; others will accept cert via commit quorum already verified
        return this.identity;
      });
      const fc = buildFinalityCertificate(synthetic, cert, {
        networkId: this.bootstrap.networkId,
        domainId: this.bootstrap.domainId,
        epoch: this.epoch,
        finalizers: [this.identity],
      });
      this.finalityCerts.set(digest, fc);
      this.economic.markFinalized(batchId);
      const pendFin = this.pendingProposals.get(digest);
      if (pendFin?.batchIds) {
        for (const id of pendFin.batchIds) this.economic.markFinalized(id);
      }
      this.noteProgress();
      this.mesh.broadcast(
        "FINALITY_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(this.identity, "FINALITY_CERT", this.epoch, height, {
              cert: fc,
              batchId,
              stateRoot,
            }),
          ),
          "utf8",
        ),
      );
      emit({
        event: "finalized",
        batchId,
        stateRoot: this.economic.stateRoot(),
      });
    }
  }

  async close(): Promise<void> {
    await this.mesh.close();
  }
}

/** CLI entry when run as main */
async function main(): Promise<void> {
  const nodeId = process.env.UEP_NODE_ID ?? "mn-0";
  const bootstrap = process.env.UEP_BOOTSTRAP;
  if (!bootstrap) {
    emit({ event: "error", reason: "UEP_BOOTSTRAP required" });
    process.exit(1);
  }
  const rt = new ProcessNodeRuntime();
  await rt.init(bootstrap, nodeId);

  const assembleTimer = setInterval(() => rt.tickAssemble(), 50);
  assembleTimer.unref?.();

  const rl = await import("node:readline");
  const interface_ = rl.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of interface_) {
    if (!line.trim()) continue;
    let msg: { cmd: string; [k: string]: unknown };
    try {
      msg = JSON.parse(line) as { cmd: string };
    } catch {
      continue;
    }
    if (msg.cmd === "connect") {
      await rt.connectPeers(
        msg.peers as Array<{ id: string; port: number; host?: string }>,
      );
    } else if (msg.cmd === "propose") {
      const txs = (
        msg.txs as Array<{
          id: string;
          from: string;
          to: string;
          amount: string;
          price?: string;
          kind?: string;
          holdId?: string;
          obligationId?: string;
          providerId?: string;
          auth?: BatchTx["auth"];
        }>
      ).map((t) => ({
        id: t.id,
        from: t.from,
        to: t.to,
        amount: BigInt(t.amount),
        ...(t.kind ? { kind: t.kind as BatchTx["kind"] } : {}),
        ...(t.holdId ? { holdId: t.holdId } : {}),
        ...(t.obligationId ? { obligationId: t.obligationId } : {}),
        ...(t.providerId ? { providerId: t.providerId } : {}),
        ...(t.price !== undefined ? { price: BigInt(t.price) } : {}),
        ...(t.auth ? { auth: t.auth } : {}),
      }));
      await rt.propose(txs);
    } else if (msg.cmd === "propose-aggregate") {
      const batches = (
        msg.batches as Array<
          Array<{
            id: string;
            from: string;
            to: string;
            amount: string;
            price?: string;
            kind?: string;
            holdId?: string;
            obligationId?: string;
            providerId?: string;
          }>
        >
      ).map((batch) =>
        batch.map((t) => ({
          id: t.id,
          from: t.from,
          to: t.to,
          amount: BigInt(t.amount),
          ...(t.kind ? { kind: t.kind as BatchTx["kind"] } : {}),
          ...(t.holdId ? { holdId: t.holdId } : {}),
          ...(t.obligationId ? { obligationId: t.obligationId } : {}),
          ...(t.providerId ? { providerId: t.providerId } : {}),
          ...(t.price !== undefined ? { price: BigInt(t.price) } : {}),
        })),
      );
      await rt.proposeAggregate(batches);
    } else if (msg.cmd === "partition") {
      rt.setPartition((msg.blocked as string[]) ?? []);
    } else if (msg.cmd === "heal") {
      rt.healPartition();
    } else if (msg.cmd === "resync") {
      rt.resyncCerts();
    } else if (msg.cmd === "advance-view") {
      rt.advanceViewLocal((msg.reason as ViewChangeReason) ?? "MANUAL");
    } else if (msg.cmd === "status") {
      rt.status();
    } else if (msg.cmd === "shutdown") {
      clearInterval(assembleTimer);
      await rt.close();
      emit({ event: "shutdown" });
      process.exit(0);
    }
  }
}

const isMain =
  process.argv[1]?.includes("uep35-process-node") ||
  process.env.UEP_PROCESS_NODE === "1";

if (isMain) {
  main().catch((e) => {
    emit({ event: "error", reason: String(e) });
    process.exit(1);
  });
}

export { ProcessNodeRuntime };
