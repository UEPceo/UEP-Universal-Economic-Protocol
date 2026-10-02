/**
 * UEP-35.1 / 35.3.1 — Dissemination + convergence (catch-up, dedup, vote aggregation).
 *
 * LAB TCP mesh. Not production gossip / peer discovery.
 */

import net from "node:net";
import type {
  TransitionProposal,
  CommitCert,
  CommitVote,
} from "./uep34-commit-cert.ts";
import {
  ProposalBoard,
  VoteBoard,
  verifyCommitCert,
  verifyCommitVote,
  assembleCommitCert,
  disseminateQcVotes,
  signCommitVote,
} from "./uep34-commit-cert.ts";
import type { FinalityCertificate } from "./uep35-finality.ts";
import { FinalityLedger } from "./uep35-finality.ts";
import type { QuorumVote } from "./uep34-voter.ts";
import { assertBftConfig, type BftProfile } from "./uep35-bft-gate.ts";
import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";

export type DissemMessage =
  | { type: "proposal"; proposal: TransitionProposal; msgId?: string }
  | { type: "commit_vote"; vote: CommitVote; msgId?: string }
  | { type: "commit_cert"; cert: CommitCert; msgId?: string }
  | { type: "qc_vote"; epoch: number; digest: string; vote: QuorumVote; msgId?: string }
  | { type: "finality_cert"; cert: FinalityCertificate; msgId?: string }
  | { type: "catchup_req"; fromSequence: number; fromNodeId: string; signature: string; msgId?: string }
  | {
      type: "catchup_res";
      fromSequence: number;
      fromNodeId: string;
      signature: string;
      proposals: TransitionProposal[];
      certs: CommitCert[];
      finals: FinalityCertificate[];
      msgId?: string;
    }
  | { type: "ping"; ts: number; msgId?: string };

function encode(msg: DissemMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function msgKey(msg: DissemMessage): string {
  if (msg.msgId) return msg.msgId;
  switch (msg.type) {
    case "proposal":
      return `p:${msg.proposal.digest}`;
    case "commit_vote":
      return `cv:${msg.vote.nodeId}:${msg.vote.proposalDigest}`;
    case "commit_cert":
      return `cc:${msg.cert.proposal.digest}`;
    case "qc_vote":
      return `qv:${msg.epoch}:${msg.digest}:${msg.vote.nodeId}`;
    case "finality_cert":
      return `fc:${msg.cert.proposalDigest}`;
    case "catchup_req":
      return `cuq:${msg.fromSequence}:${Date.now()}`;
    case "catchup_res":
      return `cur:${msg.fromSequence}:${msg.proposals.length}:${msg.certs.length}`;
    case "ping":
      return `ping:${msg.ts}`;
  }
}

type Sock = {
  socket: net.Socket;
  buf: Buffer;
  peerId?: string;
};

export type DissemNodeConfig = {
  nodeId: string;
  networkId: string;
  domainId: number;
  candidates: string[];
  publicKeyOf: (nodeId: string) => string | undefined;
  listenHost?: string;
  /** Identity for signing commit votes (distributed aggregation). */
  identity?: NodeIdentity;
  /**
   * BFT-CLASSIC (default): require N=3f+1 and quorum 2f+1.
   * LAB-MAJORITY: only for non-BFT experiments.
   */
  bftProfile?: BftProfile;
};

export class DissemNode {
  readonly cfg: DissemNodeConfig;
  readonly proposalBoard = new ProposalBoard();
  readonly voteBoard = new VoteBoard();
  readonly finality = new FinalityLedger();
  /** digest → CommitVote[] for distributed aggregation */
  private commitVotes = new Map<string, Map<string, CommitVote>>();
  /** digest → CommitCert once formed */
  private commitCerts = new Map<string, CommitCert>();
  /** sequence → FinalityCertificate accepted */
  private finalsBySeq = new Map<number, FinalityCertificate>();
  /** Ordered log for catch-up (deduped entries) */
  private log: DissemMessage[] = [];
  /** Seen message keys for deduplication */
  private seen = new Set<string>();
  /** Stats */
  stats = { received: 0, applied: 0, duplicates: 0, catchupServed: 0 };
  private server: net.Server | null = null;
  private peers = new Set<Sock>();
  private port = 0;
  partitioned = false;
  onMessage?: (msg: DissemMessage, from?: string) => void;
  /** Pending finals waiting for lower sequences */
  private pendingFinals = new Map<number, FinalityCertificate>();

  constructor(cfg: DissemNodeConfig) {
    const profile = cfg.bftProfile ?? "BFT-CLASSIC";
    const gate = assertBftConfig(cfg.candidates.length, profile);
    if (!gate.ok) {
      throw new Error(`BFT_CONFIG:${gate.reason}`);
    }
    this.cfg = { ...cfg, bftProfile: profile };
  }

  /** Classic or lab quorum from gate (never silent majority on BFT path). */
  quorumNeeded(): number {
    const profile = this.cfg.bftProfile ?? "BFT-CLASSIC";
    const gate = assertBftConfig(this.cfg.candidates.length, profile);
    if (!gate.ok) throw new Error(`BFT_CONFIG:${gate.reason}`);
    return gate.params.quorum;
  }

  async listen(preferredPort = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.attach(socket));
      this.server.once("error", reject);
      this.server.listen(preferredPort, this.cfg.listenHost ?? "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  get listenPort(): number {
    return this.port;
  }

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port }, () => {
        this.attach(s);
        resolve();
      });
      s.once("error", reject);
    });
  }

  private attach(socket: net.Socket): void {
    const st: Sock = { socket, buf: Buffer.alloc(0) };
    this.peers.add(st);
    socket.on("data", (chunk) => {
      if (this.partitioned) return;
      st.buf = Buffer.concat([st.buf, chunk]);
      while (st.buf.length >= 4) {
        const n = st.buf.readUInt32BE(0);
        if (st.buf.length < 4 + n) break;
        const body = st.buf.subarray(4, 4 + n);
        st.buf = st.buf.subarray(4 + n);
        try {
          const msg = JSON.parse(body.toString("utf8")) as DissemMessage;
          this.ingest(msg, false);
          this.onMessage?.(msg, st.peerId);
        } catch {
          /* ignore */
        }
      }
    });
    socket.on("close", () => this.peers.delete(st));
    socket.on("error", () => this.peers.delete(st));
  }

  /**
   * Ingest with deduplication. localOrigin=true skips network write when already broadcasting.
   */
  ingest(msg: DissemMessage, fromBroadcast: boolean): void {
    if (this.partitioned && !fromBroadcast) return;
    this.stats.received++;
    const key = msgKey(msg);
    // catchup_req always processed (not deduped by fixed key)
    if (msg.type !== "catchup_req" && msg.type !== "ping") {
      if (this.seen.has(key)) {
        this.stats.duplicates++;
        return;
      }
      this.seen.add(key);
    }
    this.stats.applied++;
    this.handle(msg);
  }

  private handle(msg: DissemMessage): void {
    switch (msg.type) {
      case "proposal": {
        const r = this.proposalBoard.register(msg.proposal);
        if (r.ok) {
          this.log.push(msg);
          this.finality.markProposed(
            msg.proposal.sequence,
            msg.proposal.newStateRoot,
            msg.proposal.digest,
          );
          // Auto-vote if we have identity
          if (this.cfg.identity) {
            const vote = signCommitVote(this.cfg.identity, msg.proposal.digest);
            this.ingest({ type: "commit_vote", vote }, true);
            this.relay({ type: "commit_vote", vote });
          }
        }
        break;
      }
      case "commit_vote": {
        const pk = this.cfg.publicKeyOf(msg.vote.nodeId);
        if (!pk || !verifyCommitVote(msg.vote, pk)) break;
        let m = this.commitVotes.get(msg.vote.proposalDigest);
        if (!m) {
          m = new Map();
          this.commitVotes.set(msg.vote.proposalDigest, m);
        }
        m.set(msg.vote.nodeId, msg.vote);
        this.tryFormCommitCert(msg.vote.proposalDigest);
        break;
      }
      case "commit_cert": {
        const vr = verifyCommitCert(
          msg.cert,
          this.cfg.candidates,
          this.cfg.publicKeyOf,
          this.proposalBoard,
          { bftProfile: this.cfg.bftProfile ?? "BFT-CLASSIC" },
        );
        if (vr.ok) {
          this.commitCerts.set(msg.cert.proposal.digest, msg.cert);
          this.log.push(msg);
          this.finality.markCommitted(
            msg.cert.proposal.sequence,
            msg.cert.proposal.digest,
          );
        }
        break;
      }
      case "qc_vote":
        disseminateQcVotes(this.voteBoard, msg.epoch, msg.digest, [msg.vote]);
        break;
      case "finality_cert":
        this.acceptFinalOrdered(msg.cert);
        break;
      case "catchup_req": {
        // Authenticate requester if signature present
        if (msg.fromNodeId && msg.signature && msg.signature !== "unsigned") {
          const pk = this.cfg.publicKeyOf(msg.fromNodeId);
          const body = `UEP-35-CU-REQ|${msg.fromNodeId}|${msg.fromSequence}`;
          if (!pk || !verifyBytes(pk, body, msg.signature)) break;
        }
        this.serveCatchup(msg.fromSequence, msg.fromNodeId);
        break;
      }
      case "catchup_res":
        this.applyCatchup(msg);
        break;
      default:
        break;
    }
  }

  private tryFormCommitCert(digest: string): void {
    if (this.commitCerts.has(digest)) return;
    const prop = this.proposalBoard.get(digest);
    if (!prop) return;
    const votesMap = this.commitVotes.get(digest);
    if (!votesMap) return;
    const votes = [...votesMap.values()];
    const need = this.quorumNeeded();
    if (votes.length < need) return;
    const cert = assembleCommitCert(prop, votes);
    const vr = verifyCommitCert(
      cert,
      this.cfg.candidates,
      this.cfg.publicKeyOf,
      this.proposalBoard,
      { bftProfile: this.cfg.bftProfile ?? "BFT-CLASSIC" },
    );
    if (!vr.ok) return;
    this.commitCerts.set(digest, cert);
    this.log.push({ type: "commit_cert", cert });
    this.finality.markCommitted(prop.sequence, digest);
    // Relay cert so peers learn
    this.relay({ type: "commit_cert", cert });
  }

  /**
   * Accept finals in order: buffer if gap; apply consecutive.
   */
  private acceptFinalOrdered(fc: FinalityCertificate): void {
    this.pendingFinals.set(fc.sequence, fc);
    this.drainPendingFinals();
  }

  private drainPendingFinals(): void {
    // Strict sequential finality: only lastFinal+1 (or seq 1 if none yet).
    let progressed = true;
    while (progressed) {
      progressed = false;
      const last = this.finality.lastFinalSequence();
      const next = last < 0 ? 1 : last + 1;
      const fc = this.pendingFinals.get(next);
      if (!fc) return;
      const r = this.finality.acceptFinal(
        fc,
        this.cfg.candidates,
        this.cfg.publicKeyOf,
      );
      if (r.ok) {
        this.pendingFinals.delete(next);
        this.finalsBySeq.set(next, fc);
        this.log.push({ type: "finality_cert", cert: fc });
        this.pruneAtFinality(next);
        progressed = true;
      } else {
        // invalid cert for this sequence — drop so we do not block forever
        this.pendingFinals.delete(next);
      }
    }
  }

  private serveCatchup(fromSequence: number, requesterId?: string): void {
    this.stats.catchupServed++;
    const proposals: TransitionProposal[] = [];
    const certs: CommitCert[] = [];
    const finals: FinalityCertificate[] = [];
    for (const msg of this.log) {
      if (msg.type === "proposal" && msg.proposal.sequence >= fromSequence) {
        proposals.push(msg.proposal);
      }
      if (msg.type === "commit_cert" && msg.cert.proposal.sequence >= fromSequence) {
        certs.push(msg.cert);
      }
      if (msg.type === "finality_cert" && msg.cert.sequence >= fromSequence) {
        finals.push(msg.cert);
      }
    }
    for (const [, fc] of this.finalsBySeq) {
      if (fc.sequence >= fromSequence && !finals.some((f) => f.proposalDigest === fc.proposalDigest)) {
        finals.push(fc);
      }
    }
    const fromNodeId = this.cfg.nodeId;
    const body = `UEP-35-CU-RES|${fromNodeId}|${fromSequence}|${proposals.length}|${certs.length}|${finals.length}`;
    const signature = this.cfg.identity
      ? signBytes(this.cfg.identity, body)
      : "unsigned";
    this.relay({
      type: "catchup_res",
      fromSequence,
      fromNodeId,
      signature,
      proposals,
      certs,
      finals,
    });
  }

  private applyCatchup(msg: Extract<DissemMessage, { type: "catchup_res" }>): void {
    if (msg.signature && msg.signature !== "unsigned") {
      const pk = this.cfg.publicKeyOf(msg.fromNodeId);
      const body = `UEP-35-CU-RES|${msg.fromNodeId}|${msg.fromSequence}|${msg.proposals.length}|${msg.certs.length}|${msg.finals.length}`;
      if (!pk || !verifyBytes(pk, body, msg.signature)) return;
    }
    for (const p of msg.proposals) {
      this.ingest({ type: "proposal", proposal: p }, true);
    }
    for (const c of msg.certs) {
      this.ingest({ type: "commit_cert", cert: c }, true);
    }
    // Sort finals by sequence for ordered apply
    const sorted = [...msg.finals].sort((a, b) => a.sequence - b.sequence);
    for (const f of sorted) {
      this.ingest({ type: "finality_cert", cert: f }, true);
    }
  }


  /**
   * Safe pruning: drop seen keys and log entries strictly below finality watermark.
   * Keeps last FINAL sequence fully; never prunes non-finalized data.
   */
  private pruneAtFinality(watermark: number): void {
    // Remove log entries with sequence < watermark (keep watermark itself)
    this.log = this.log.filter((msg) => {
      const seq = this.msgSequence(msg);
      return seq === null || seq >= watermark;
    });
    // Prune seen keys that encode finalized sequences below watermark
    for (const key of [...this.seen]) {
      const m = /(?:^|:)seq=(\d+)/.exec(key);
      // also prune proposal digests only tracked via log — keep seen size bounded
    }
    // Bound seen: if > 10_000, drop keys not in recent log
    if (this.seen.size > 10_000) {
      const keep = new Set(this.log.map((m) => msgKey(m)));
      for (const k of [...this.seen]) {
        if (!keep.has(k)) this.seen.delete(k);
      }
    }
    // Drop commitVotes for digests already finalized below watermark
    for (const [digest, cert] of [...this.commitCerts]) {
      if (cert.proposal.sequence < watermark) {
        this.commitVotes.delete(digest);
      }
    }
  }

  private msgSequence(msg: DissemMessage): number | null {
    switch (msg.type) {
      case "proposal":
        return msg.proposal.sequence;
      case "commit_cert":
        return msg.cert.proposal.sequence;
      case "finality_cert":
        return msg.cert.sequence;
      default:
        return null;
    }
  }

  /** Request catch-up from peers starting after last known final (or 1). */
  requestCatchup(): void {
    const from = Math.max(1, this.finality.lastFinalSequence() + 1);
    const fromNodeId = this.cfg.nodeId;
    const body = `UEP-35-CU-REQ|${fromNodeId}|${from}`;
    const signature = this.cfg.identity
      ? signBytes(this.cfg.identity, body)
      : "unsigned";
    this.relay({ type: "catchup_req", fromSequence: from, fromNodeId, signature });
  }

  private relay(msg: DissemMessage): void {
    if (this.partitioned) return;
    const buf = encode(msg);
    for (const p of this.peers) {
      if (!p.socket.destroyed) {
        try {
          p.socket.write(buf);
        } catch {
          /* ignore */
        }
      }
    }
  }

  broadcast(msg: DissemMessage): void {
    if (this.partitioned) return;
    this.ingest(msg, true);
    this.relay(msg);
  }

  enterPartition(): void {
    this.partitioned = true;
  }

  healPartition(): void {
    this.partitioned = false;
  }

  /** After heal: clear partition flag and request catch-up. */
  healAndCatchup(): void {
    this.healPartition();
    this.requestCatchup();
  }

  getCommitCert(digest: string): CommitCert | undefined {
    return this.commitCerts.get(digest);
  }

  getFinal(seq: number): FinalityCertificate | undefined {
    return this.finalsBySeq.get(seq);
  }

  async close(): Promise<void> {
    for (const p of this.peers) p.socket.destroy();
    this.peers.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

export async function bootDissemMesh(opts: {
  nodeIds: string[];
  networkId?: string;
  domainId?: number;
  publicKeyOf: (id: string) => string | undefined;
  identities?: Map<string, NodeIdentity>;
  bftProfile?: BftProfile;
}): Promise<DissemNode[]> {
  const networkId = opts.networkId ?? "local";
  const domainId = opts.domainId ?? 1;
  const nodes: DissemNode[] = [];
  for (const nodeId of opts.nodeIds) {
    const n = new DissemNode({
      nodeId,
      networkId,
      domainId,
      candidates: opts.nodeIds,
      publicKeyOf: opts.publicKeyOf,
      identity: opts.identities?.get(nodeId),
      bftProfile: opts.bftProfile ?? "BFT-CLASSIC",
    });
    await n.listen(0);
    nodes.push(n);
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      await nodes[i]!.connect("127.0.0.1", nodes[j]!.listenPort);
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  return nodes;
}
