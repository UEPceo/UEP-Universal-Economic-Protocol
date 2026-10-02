/**
 * UEP-35.8 — Consensus over real TCP (localhost multi-port LAB).
 */

import { createIndependentNodes, type IndependentNode } from "./uep35-multinode.ts";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import type { DagBatchHeader } from "./uep35-dag.ts";
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
  type TransitionProposal,
  type CommitVote,
} from "./uep34-commit-cert.ts";
import { buildFinalityCertificate } from "./uep35-finality.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";

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
    })),
  });
}
function decodeBody(s: string): { batchId: string; txs: BatchTx[] } {
  const j = JSON.parse(s) as {
    batchId: string;
    txs: Array<{ id: string; from: string; to: string; amount: string }>;
  };
  return {
    batchId: j.batchId,
    txs: j.txs.map((t) => ({ ...t, amount: BigInt(t.amount) })),
  };
}

export class TcpConsensusCluster {
  nodes: IndependentNode[];
  meshes = new Map<string, TcpMeshEndpoint>();
  epoch = 0;
  stats = { proposals: 0, votes: 0, commits: 0, finalities: 0, rejected: 0 };

  private constructor(nodes: IndependentNode[]) {
    this.nodes = nodes;
  }

  static async create(n = 4): Promise<TcpConsensusCluster> {
    const { nodes } = createIndependentNodes(n);
    const cluster = new TcpConsensusCluster(nodes);
    for (const node of nodes) {
      const mesh = new TcpMeshEndpoint(node.id);
      mesh.onMessage((from, kind, payload) => {
        cluster.onNet(node, from, kind, payload);
      });
      await mesh.listen("127.0.0.1", 0);
      cluster.meshes.set(node.id, mesh);
    }
    // Dial only i -> j for i < j (one TCP direction per pair; both ends registered).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const ma = cluster.meshes.get(a.id)!;
        const mb = cluster.meshes.get(b.id)!;
        await ma.connectPeer(b.id, "127.0.0.1", mb.listenPort);
      }
    }
    await new Promise((r) => setTimeout(r, 80));
    return cluster;
  }

  private mesh(id: string): TcpMeshEndpoint {
    return this.meshes.get(id)!;
  }

  private broadcast(from: string, kind: string, payload: Uint8Array): void {
    this.mesh(from).broadcast(kind, payload);
  }

  async proposeFrom(
    nodeId: string,
    txs: BatchTx[],
  ): Promise<{
    header: DagBatchHeader;
    proposalDigest: string;
    stateRoot: string;
  } | null> {
    const n = this.nodes.find((x) => x.id === nodeId)!;
    for (const tx of txs) n.worker.admit(tx);
    const produced = n.worker.produceBatch();
    if (!produced) return null;
    n.readyBatches.add(produced.header.batchId);
    this.broadcast(
      n.id,
      "BATCH_HEADER",
      Buffer.from(encodeHeader(produced.header), "utf8"),
    );
    const stateRoot = n.economic.previewRoot(produced.txs);
    if (!stateRoot) return null;
    const propPayload: ProposalPayload = {
      batchId: produced.header.batchId,
      txDigest: produced.header.txDigest,
      stateRoot,
      epoch: this.epoch,
      height: produced.header.height,
      previousStateRoot: n.economic.previousRoot(),
    };
    const env = sealConsensusMsg(
      n.identity,
      "PROPOSAL",
      this.epoch,
      produced.header.height,
      propPayload,
    );
    this.broadcast(n.id, "PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    this.stats.proposals++;
    const digest = proposalDigestFromPayload(propPayload);
    n.stages.set(digest, "proposed");
    n.pendingProposals.set(digest, propPayload);
    this.tryVote(n, digest, propPayload);
    return { header: produced.header, proposalDigest: digest, stateRoot };
  }

  async settle(ms = 300): Promise<void> {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, Math.ceil(ms / steps)));
      for (const node of this.nodes) this.tryAssemble(node);
    }
  }

  private onNet(
    node: IndependentNode,
    from: string,
    kind: string,
    payload: Uint8Array,
  ): void {
    const text = Buffer.from(payload).toString("utf8");
    if (kind === "BATCH_HEADER") {
      const h = decodeHeader(text);
      if (!node.worker.announceHeader(h, true, node.registry).ok) {
        this.stats.rejected++;
        return;
      }
      if (!node.worker.dag.hasBody(h.batchId)) {
        this.mesh(node.id).send(
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
      this.mesh(node.id).send(
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
      if (node.worker.ingestRecovery(header, txs).ok && node.worker.dag.isReady(batchId)) {
        node.readyBatches.add(batchId);
        for (const [digest, p] of node.pendingProposals) {
          if (p.batchId === batchId) this.tryVote(node, digest, p);
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
        this.handleConsensus(node, JSON.parse(text) as ConsensusEnvelope);
      } catch {
        this.stats.rejected++;
      }
    }
  }

  private handleConsensus(node: IndependentNode, env: ConsensusEnvelope): void {
    if (node.seenMsgIds.has(env.msgId)) return;
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
      const p = JSON.parse(env.payload) as ProposalPayload;
      const digest = proposalDigestFromPayload(p);
      node.pendingProposals.set(digest, p);
      node.stages.set(digest, "proposed");
      this.tryVote(node, digest, p);
      return;
    }
    if (env.type === "VOTE") {
      const v = JSON.parse(env.payload) as {
        proposalDigest: string;
        commitSig: string;
      };
      const voteKey = `${env.sender}|${v.proposalDigest}`;
      if (node.seenVotes.has(voteKey)) return;
      node.seenVotes.add(voteKey);
      const vote: CommitVote = {
        nodeId: env.sender,
        proposalDigest: v.proposalDigest,
        signature: v.commitSig,
      };
      const list = node.votes.get(v.proposalDigest) ?? [];
      list.push(vote);
      node.votes.set(v.proposalDigest, list);
      this.stats.votes++;
      return;
    }
    if (env.type === "COMMIT_CERT") {
      const payload = JSON.parse(env.payload) as {
        cert: import("./uep34-commit-cert.ts").CommitCert;
        batchId: string;
        stateRoot: string;
        height: number;
      };
      if (payload.cert.proposal.newStateRoot !== payload.stateRoot) {
        this.stats.rejected++;
        return;
      }
      node.board.register(payload.cert.proposal);
      const keys: Record<string, string> = {};
      for (const e of node.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        payload.cert,
        this.nodes.map((x) => x.id),
        (id) => keys[id],
        node.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) {
        this.stats.rejected++;
        return;
      }
      node.commitCerts.set(payload.cert.proposal.digest, payload.cert);
      if (!node.appliedBatches.has(payload.batchId)) {
        const body = node.worker.dag.getBody(payload.batchId);
        if (body) {
          const r = node.economic.applyBatch(body);
          if (r.ok && r.stateRoot === payload.stateRoot) {
            node.appliedBatches.add(payload.batchId);
          }
        }
      }
      return;
    }
    if (env.type === "FINALITY_CERT") {
      const payload = JSON.parse(env.payload) as {
        cert: import("./uep35-finality.ts").FinalityCertificate;
        batchId: string;
        stateRoot: string;
      };
      if (payload.cert.stateRoot !== payload.stateRoot) {
        this.stats.rejected++;
        return;
      }
      if (node.economic.isFinalized(payload.batchId)) return;
      node.board.register(payload.cert.commitCert.proposal);
      const keys: Record<string, string> = {};
      for (const e of node.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        payload.cert.commitCert,
        this.nodes.map((x) => x.id),
        (id) => keys[id],
        node.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) {
        this.stats.rejected++;
        return;
      }
      if (!node.appliedBatches.has(payload.batchId)) {
        const body = node.worker.dag.getBody(payload.batchId);
        if (!body) return;
        const r = node.economic.applyBatch(body);
        if (!r.ok || r.stateRoot !== payload.stateRoot) {
          this.stats.rejected++;
          return;
        }
        node.appliedBatches.add(payload.batchId);
      }
      if (node.economic.stateRoot() !== payload.stateRoot) {
        this.stats.rejected++;
        return;
      }
      node.finalityCerts.set(payload.cert.proposalDigest, payload.cert);
      node.economic.markFinalized(payload.batchId);
      node.stages.set(payload.cert.proposalDigest, "finalized");
      this.stats.finalities++;
    }
  }

  private tryVote(
    node: IndependentNode,
    digest: string,
    p: ProposalPayload,
  ): void {
    if (!node.worker.dag.isReady(p.batchId)) return;
    const body = node.worker.dag.getBody(p.batchId);
    if (!body) return;
    if (node.economic.previewRoot(body) !== p.stateRoot) {
      this.stats.rejected++;
      return;
    }
    if (node.seenVotes.has(`${node.id}|${digest}`)) return;
    const vote = signCommitVote(node.identity, digest);
    const env = sealConsensusMsg(node.identity, "VOTE", this.epoch, p.height, {
      proposalDigest: digest,
      batchId: p.batchId,
      stateRoot: p.stateRoot,
      commitSig: vote.signature,
    });
    this.broadcast(node.id, "VOTE", Buffer.from(JSON.stringify(env), "utf8"));
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
      const byVoter = new Map<string, CommitVote>();
      for (const v of votes) byVoter.set(v.nodeId, v);
      if (byVoter.size < need) continue;
      let batchId: string | null = null;
      let stateRoot: string | null = null;
      let height = 0;
      for (const b of node.readyBatches) {
        const body = node.worker.dag.getBody(b);
        const header = node.worker.dag.getHeader(b);
        if (!body || !header) continue;
        const root = node.economic.previewRoot(body);
        if (!root) continue;
        const pp: ProposalPayload = {
          batchId: b,
          txDigest: header.txDigest,
          stateRoot: root,
          epoch: this.epoch,
          height: header.height,
          previousStateRoot: node.economic.previousRoot(),
        };
        if (proposalDigestFromPayload(pp) === digest) {
          batchId = b;
          stateRoot = root;
          height = header.height;
          break;
        }
      }
      if (!batchId || !stateRoot) continue;
      const synthetic: TransitionProposal = {
        digest,
        networkId: "lab-mn",
        domainId: 1,
        leaderNodeId: this.nodes[0]!.id,
        sequence: height,
        previousStateRoot: node.economic.previousRoot(),
        newStateRoot: stateRoot,
        nullifier: `NF-${batchId}`,
        transitionId: digest.slice(0, 32),
      };
      node.board.register(synthetic);
      const cert = assembleCommitCert(synthetic, [...byVoter.values()]);
      const keys: Record<string, string> = {};
      for (const e of node.registry.list()) keys[e.nodeId] = e.publicKeyHex;
      const vr = verifyCommitCert(
        cert,
        this.nodes.map((x) => x.id),
        (id) => keys[id],
        node.board,
        { bftProfile: "BFT-CLASSIC" },
      );
      if (!vr.ok) continue;
      node.commitCerts.set(digest, cert);
      this.stats.commits++;
      if (!node.appliedBatches.has(batchId)) {
        const body = node.worker.dag.getBody(batchId)!;
        const r = node.economic.applyBatch(body);
        if (r.ok && r.stateRoot === stateRoot) node.appliedBatches.add(batchId);
      }
      this.broadcast(
        node.id,
        "COMMIT_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(node.identity, "COMMIT_CERT", this.epoch, height, {
              cert,
              batchId,
              stateRoot,
              epoch: this.epoch,
              height,
            }),
          ),
          "utf8",
        ),
      );
      const fc = buildFinalityCertificate(synthetic, cert, {
        networkId: "lab-mn",
        domainId: 1,
        epoch: this.epoch,
        finalizers: this.nodes.map((x) => x.identity),
      });
      node.finalityCerts.set(digest, fc);
      node.economic.markFinalized(batchId);
      node.stages.set(digest, "finalized");
      this.stats.finalities++;
      this.broadcast(
        node.id,
        "FINALITY_CERT",
        Buffer.from(
          JSON.stringify(
            sealConsensusMsg(node.identity, "FINALITY_CERT", this.epoch, height, {
              cert: fc,
              batchId,
              stateRoot,
            }),
          ),
          "utf8",
        ),
      );
    }
  }

  allSameStateRoot(): boolean {
    const r0 = this.nodes[0]!.economic.stateRoot();
    return this.nodes.every((n) => n.economic.stateRoot() === r0);
  }

  allFinalized(): boolean {
    return this.nodes.every((n) => n.economic.finalizedBatchIds.size >= 1);
  }

  async close(): Promise<void> {
    for (const m of this.meshes.values()) await m.close();
  }
}
