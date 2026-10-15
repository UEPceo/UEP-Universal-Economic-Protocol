/**
 * HTTP transport for the legacy three-node spend quorum and opt-in experimental BFT kernel. Fixed peer list; no discovery.
 * A spend is applied only after two of three votes. A silent peer is skipped.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { signEd25519, verifyEd25519, type PrivateKeyLike } from "../core/ed25519.ts";
import { deserializeTx, serializeTx, txNullifiers, type UepTransaction } from "../core/transaction.ts";

type WireTx = Parameters<typeof deserializeTx>[0];
import type { UepLedger } from "../testnet/ledger.ts";
import { TxQuorum, type QuorumVote } from "./quorum.ts";
import { BftConsensusKernel, type BftCertificate, type BftProposal, type BftVote } from "./bft-consensus.ts";
import { CertifiedCommitter, CommitLog, migrateJournalV1, type CommitResult, type CommitStatus, type CommitterOptions } from "./certified-commit.ts";

/**
 * `publicKeyHex` pins the voter key. `snapshotPublicKeyHex` and `faucetPublicKeyHex` pin the keys
 * this peer signs snapshots and mints with; catch-up trusts a peer snapshot only through them.
 */
export type Peer = { id: string; url: string; publicKeyHex?: string; snapshotPublicKeyHex?: string; faucetPublicKeyHex?: string };

const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;
const decode = (_k: string, v: unknown) => v && typeof v === "object" && "$b" in v && typeof (v as { $b: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;

/** Hard cap for peer HTTP bodies (tx, vote, commit, propose). Snapshots are served via GET /snapshot and are not subject to this POST limit. */
const MAX_PEER_BODY = 2 * 1024 * 1024; // 2 MiB
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // generous for local harness; still bounds floods
const NODE_VERSION = "0.5.81";

export class PeerNet {
  readonly id: string;
  readonly startedAt = Date.now();
  /** Replaced only by `catchUp`. Whoever serves this ledger (the node API) must be built after catch-up, or read it from here. */
  ledger: UepLedger;
  private readonly privateKey: PrivateKeyLike;
  readonly publicKeyHex: string;
  peers: Peer[];
  private readonly txs = new Map<string, UepTransaction>();
  readonly quorum: TxQuorum;
  server?: Server;
  private applyChain: Promise<unknown> = Promise.resolve();

  private readonly threshold: number;
  private readonly statePath?: string;
  private bftKernel?: BftConsensusKernel;
  private readonly bftProposals = new Map<string, { proposal: BftProposal; signature: string }>();
  private readonly bftTransactions = new Map<string, UepTransaction>();
  private readonly bftJournalPath?: string;
  private readonly commitLogPath?: string;
  private committer?: CertifiedCommitter;
  /** Crash-test hook passed to the certified committer. */
  commitFaultInjector?: CommitterOptions["faultInjector"];

  constructor(id: string, ledger: UepLedger, privateKey: PrivateKeyLike, publicKeyHex: string, peers: Peer[], voters: Map<string, string>, threshold = 2, stateDir?: string) {
    this.id = id;
    this.ledger = ledger;
    this.privateKey = privateKey;
    this.publicKeyHex = publicKeyHex;
    this.peers = peers;
    this.threshold = threshold;
    this.quorum = new TxQuorum(voters, threshold, { networkId: ledger.networkId, domainId: ledger.domainId });
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true });
      this.statePath = join(stateDir, "quorum-votes.json");
      this.bftJournalPath = join(stateDir, "bft-commit-journal.json");
      this.commitLogPath = join(stateDir, "bft-commit-log.jsonl");
      if (existsSync(this.statePath)) {
        const raw = JSON.parse(readFileSync(this.statePath, "utf8"));
        if (raw.version === 1 && raw.payload && raw.signature && raw.signer === this.publicKeyHex) {
          if (!verifyEd25519(raw.payload, raw.signature, this.publicKeyHex)) {
            console.error("[uep-peer] quorum state signature invalid; ignoring");
          } else {
            this.quorum.loadState(JSON.parse(raw.payload));
          }
        } else {
          // Legacy unsigned format still accepted once, then re-saved signed.
          this.quorum.loadState(raw);
          this.saveQuorum();
        }
      }
    }
  }

  /** Attach the experimental BFT kernel to this authenticated validator transport.
   * The BFT validator identity must be the same pinned key as this PeerNet identity.
   */
  configureBftConsensus(kernel: BftConsensusKernel): void {
    const validator = kernel.validators.find(item => item.id === this.id);
    if (!validator || validator.publicKeyHex !== this.publicKeyHex) throw new Error("BFT_TRANSPORT_VALIDATOR_KEY_MISMATCH");
    if (kernel.domain.networkId !== this.ledger.networkId || kernel.domain.domainId !== this.ledger.domainId) {
      throw new Error("BFT_TRANSPORT_DOMAIN_MISMATCH");
    }
    this.bftKernel = kernel;
    // H1: one durable, hash-chained commit log per node; the 0.5.80 JSON journal is migrated once.
    const log = new CommitLog(this.commitLogPath ?? null);
    if (this.bftJournalPath && existsSync(this.bftJournalPath)) {
      migrateJournalV1(this.bftJournalPath, log);
      renameSync(this.bftJournalPath, this.bftJournalPath + ".migrated");
    }
    this.committer = new CertifiedCommitter(log, kernel, () => this.ledger, { faultInjector: (p) => this.commitFaultInjector?.(p) });
  }

  /** Commit status of a BFT height: CERTIFIED_NOT_APPLIED is never counted as applied. */
  bftCommitStatus(height: number): CommitStatus {
    const st = this.requireCommitter().status(height);
    if (st !== "UNKNOWN") return st;
    // Certified by the kernel (for example a certificate without a ledger transaction) but not applied here.
    return this.requireBft().exportState().committed.some(([h]) => h === String(height)) ? "CERTIFIED_NOT_APPLIED" : "UNKNOWN";
  }

  bftCommitResult(height: number): CommitResult | undefined { return this.requireCommitter().result(height); }

  private requireCommitter(): CertifiedCommitter {
    if (!this.committer) throw new Error("BFT_TRANSPORT_NOT_CONFIGURED");
    return this.committer;
  }

  /** Drive a BFT proposal. Supplying tx binds blockId to txId and enables certified ledger application. */
  async bftPropose(proposal: BftProposal, tx?: UepTransaction): Promise<BftCertificate> {
    const kernel = this.requireBft();
    if (proposal.proposerId !== this.id || kernel.leader(proposal.height, proposal.round) !== this.id) {
      throw new Error("BFT_TRANSPORT_NOT_LEADER");
    }
    if (tx) this.assertBftTransaction(proposal, tx);
    const signature = kernel.signProposal(proposal, this.privateKey);
    if (!kernel.verifyProposal(proposal, signature)) throw new Error("BFT_TRANSPORT_PROPOSAL_INVALID");
    this.bftProposals.set(this.bftPosition(proposal), { proposal: structuredClone(proposal), signature });
    if (tx) this.bftTransactions.set(proposal.blockId, tx);
    const wireTx = tx ? JSON.parse(JSON.stringify(serializeTx(tx), encode)) as WireTx : undefined;
    const mine = kernel.createVote(proposal, "prevote", this.id, this.privateKey, signature);
    const replies = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/proposal", this.signed("/bft/proposal", { proposal, proposalSignature: signature, ...(wireTx ? { tx: wireTx } : {}) }))));
    const prevotes = [mine, ...replies.map(reply => reply?.vote as BftVote | undefined).filter((vote): vote is BftVote => !!vote)];
    const prevoteCertificate = kernel.voteCertificate(proposal.height, proposal.round, "prevote", proposal.blockId, prevotes);
    kernel.observePrevoteCertificate(prevoteCertificate);

    // The certificate is part of the signed precommit proposal; validators never
    // accept a precommit based on an unsigned or mismatched certificate.
    const lockedProposal: BftProposal = { ...proposal, prevoteCertificate };
    const lockedSignature = kernel.signProposal(lockedProposal, this.privateKey);
    this.bftProposals.set(this.bftPosition(lockedProposal), { proposal: structuredClone(lockedProposal), signature: lockedSignature });
    const localPrecommit = kernel.createVote(lockedProposal, "precommit", this.id, this.privateKey, lockedSignature);
    const lockReplies = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/prevote-certificate", this.signed("/bft/prevote-certificate", { proposal: lockedProposal, proposalSignature: lockedSignature, certificate: prevoteCertificate }))));
    const precommits = [localPrecommit, ...lockReplies.map(reply => reply?.vote as BftVote | undefined).filter((vote): vote is BftVote => !!vote)];
    const commitCertificate = kernel.voteCertificate(proposal.height, proposal.round, "precommit", proposal.blockId, precommits);
    if (tx) await this.applyBftCommit(lockedProposal, commitCertificate, tx);
    else kernel.recordCommit(commitCertificate);
    const commits = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/commit-certificate", this.signed("/bft/commit-certificate", { certificate: commitCertificate }))));
    const accepted = commits.filter(reply => reply?.accepted === true).length;
    if (accepted < kernel.quorum - 1) throw new Error("BFT_TRANSPORT_COMMIT_ACKS_INSUFFICIENT");
    return commitCertificate;
  }

  private assertBftTransaction(proposal: BftProposal, tx: UepTransaction): void {
    if (proposal.blockId !== tx.txId.toHex()) throw new Error("BFT_TX_ID_MISMATCH");
    const committer = this.requireCommitter();
    if (proposal.height !== committer.expectedHeight()) throw new Error("BFT_HEIGHT_MISMATCH");
    if (proposal.parentRoot !== this.ledger.stateRoot().toHex() || proposal.parentRoot !== committer.expectedParentRoot()) {
      throw new Error("BFT_PARENT_STATE_MISMATCH");
    }
    const checked = this.ledger.validateSpend(tx);
    if ("error" in checked) throw new Error(checked.error.code);
  }

  /** Certified ledger application goes through the single idempotent transition (H1, ADR 0007). */
  private async applyBftCommit(proposal: BftProposal, certificate: BftCertificate, tx: UepTransaction): Promise<CommitResult> {
    const proposalSignature = this.bftProposals.get(this.bftPosition(proposal))?.signature;
    if (!proposalSignature) throw new Error("BFT_JOURNAL_PROPOSAL_SIGNATURE_INVALID");
    const committer = this.requireCommitter();
    return this.enqueue(() => committer.applyCertifiedCommit({ proposal, proposalSignature, certificate, tx }));
  }

  /** After a restart: restore the ledger snapshot, configure BFT, then call this. Returns the heights re-applied to the ledger. */
  async recoverBftCommits(): Promise<number> {
    const committer = this.requireCommitter();
    const out = await this.enqueue(() => committer.recover());
    for (const e of committer.log.all()) {
      if (e.type === "INTENT") {
        this.bftProposals.set(this.bftPosition(e.proposal!), { proposal: structuredClone(e.proposal!), signature: e.proposalSignature! });
      }
    }
    return out.reapplied;
  }

  private requireBft(): BftConsensusKernel {
    if (!this.bftKernel) throw new Error("BFT_TRANSPORT_NOT_CONFIGURED");
    return this.bftKernel;
  }

  private bftPosition(proposal: Pick<BftProposal, "height" | "round">): string {
    return `${proposal.height}:${proposal.round}`;
  }

  knownVoter(id: string): string | undefined {
    return (this.quorum as unknown as { voters: Map<string, string> }).voters.get(id);
  }

  private signed(path: string, payload: unknown): Record<string, unknown> {
    const message = `uep-peer:${this.id}:${path}:${JSON.stringify(payload)}`;
    return { from: this.id, signature: signEd25519(message, this.privateKey), payload };
  }

  private saveQuorum(): void {
    if (!this.statePath) return;
    const state = this.quorum.exportState();
    const payload = JSON.stringify(state);
    const signature = signEd25519(payload, this.privateKey);
    writeFileSync(this.statePath, JSON.stringify({ version: 1, payload, signature, signer: this.publicKeyHex }));
  }

  private readonly rateHits = new Map<string, number[]>();

  private rateOk(ip: string): boolean {
    const now = Date.now();
    const hits = (this.rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX) return false;
    hits.push(now);
    this.rateHits.set(ip, hits);
    if (this.rateHits.size > 10_000) this.rateHits.clear(); // crude bound
    return true;
  }

  listen(port = 0): Promise<number> {
    this.server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const ip = req.socket.remoteAddress ?? "unknown";
        if (!this.rateOk(ip)) return send(res, 429, { error: "RATE_LIMITED" });
        if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
        if (req.method === "POST") {
          const ct = String(req.headers["content-type"] ?? "").toLowerCase();
          if (!ct.includes("application/json")) return send(res, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
        }
        if (req.method === "GET" && url.pathname === "/status") {
          const now = Date.now();
          const recentHits = [...this.rateHits.values()].reduce((n, hits) => n + hits.filter((t) => now - t < RATE_WINDOW_MS).length, 0);
          return send(res, 200, {
            id: this.id,
            version: NODE_VERSION,
            height: this.ledger.height,
            txCount: this.ledger.txs.length,
            stateRoot: this.ledger.stateRoot().toHex(),
            publicKeyHex: this.publicKeyHex,
            startedAt: this.startedAt,
            uptimeMs: now - this.startedAt,
            peerCount: this.peers.length,
            threshold: this.threshold,
            rateLimit: { windowMs: RATE_WINDOW_MS, max: RATE_MAX, recentHits },
            ...(this.committer ? { bftCommit: { lastDecidedHeight: this.committer.lastDecidedHeight(), pendingNotApplied: this.committer.pending(), logHead: this.committer.log.headHash } } : {}),
          });
        }
        if (req.method === "GET" && url.pathname === "/snapshot") {
          return send(res, 200, this.ledger.snapshot());
        }
        if (req.method === "GET" && url.pathname === "/txs") {
          const txs = this.ledger.txs.slice(-20).map((tx) => tx.txId.toHex());
          return send(res, 200, { id: this.id, height: this.ledger.height, stateRoot: this.ledger.stateRoot().toHex(), txCount: this.ledger.txs.length, recent: txs });
        }
        const raw = await readJson(req);
        const peerPaths = new Set(["/tx", "/vote", "/commit", "/bft/proposal", "/bft/prevote-certificate", "/bft/commit-certificate"]);
        let body = raw;
        let authenticatedFrom: string | undefined;
        if (req.method === "POST" && peerPaths.has(url.pathname)) {
          const from = String(raw.from ?? "");
          authenticatedFrom = from;
          const expected = this.knownVoter(from);
          const message = `uep-peer:${from}:${url.pathname}:${JSON.stringify(raw.payload)}`;
          if (!expected || !verifyEd25519(message, String(raw.signature ?? ""), expected)) {
            console.error(`[uep-peer] PEER_AUTH failed from=${from} path=${url.pathname} ip=${ip}`);
            return send(res, 401, { error: "PEER_AUTH" });
          }
          body = raw.payload as Record<string, unknown>;
        }
        if (req.method === "POST" && url.pathname.startsWith("/bft/")) {
          const kernel = this.requireBft();
          if (!authenticatedFrom) return send(res, 401, { error: "PEER_AUTH" });
          if (url.pathname === "/bft/proposal") {
            const proposal = body.proposal as BftProposal;
            const proposalSignature = String(body.proposalSignature ?? "");
            if (!proposal || proposal.proposerId !== authenticatedFrom || !kernel.verifyProposal(proposal, proposalSignature)) {
              return send(res, 400, { error: "BFT_PROPOSAL_AUTH_INVALID" });
            }
            const key = this.bftPosition(proposal);
            const prior = this.bftProposals.get(key);
            if (prior && (prior.proposal.blockId !== proposal.blockId || prior.signature !== proposalSignature)) {
              return send(res, 409, { error: "BFT_PROPOSAL_EQUIVOCATION" });
            }
            if (body.tx !== undefined) {
              const tx = deserializeTx(body.tx as WireTx);
              this.assertBftTransaction(proposal, tx);
              this.bftTransactions.set(proposal.blockId, tx);
            }
            this.bftProposals.set(key, { proposal: structuredClone(proposal), signature: proposalSignature });
            const vote = kernel.createVote(proposal, "prevote", this.id, this.privateKey, proposalSignature);
            return send(res, 200, { accepted: true, vote });
          }
          if (url.pathname === "/bft/prevote-certificate") {
            const proposal = body.proposal as BftProposal;
            const proposalSignature = String(body.proposalSignature ?? "");
            const certificate = body.certificate as BftCertificate;
            if (!proposal || proposal.proposerId !== authenticatedFrom || !kernel.verifyProposal(proposal, proposalSignature) ||
                !certificate || certificate.phase !== "prevote" || certificate.height !== proposal.height ||
                certificate.round !== proposal.round || certificate.blockId !== proposal.blockId || !kernel.verifyCertificate(certificate) ||
                !proposal.prevoteCertificate || JSON.stringify(proposal.prevoteCertificate) !== JSON.stringify(certificate)) {
              return send(res, 400, { error: "BFT_PREVOTE_CERTIFICATE_INVALID" });
            }
            const key = this.bftPosition(proposal);
            const prior = this.bftProposals.get(key);
            if (prior && prior.proposal.blockId !== proposal.blockId) return send(res, 409, { error: "BFT_PROPOSAL_EQUIVOCATION" });
            kernel.observePrevoteCertificate(certificate);
            this.bftProposals.set(key, { proposal: structuredClone(proposal), signature: proposalSignature });
            const vote = kernel.createVote(proposal, "precommit", this.id, this.privateKey, proposalSignature);
            return send(res, 200, { accepted: true, vote });
          }
          if (url.pathname === "/bft/commit-certificate") {
            const certificate = body.certificate as BftCertificate;
            if (!certificate || certificate.phase !== "precommit" || !kernel.verifyCertificate(certificate)) {
              return send(res, 400, { error: "BFT_COMMIT_CERTIFICATE_INVALID" });
            }
            const committedProposal = this.bftProposals.get(`${certificate.height}:${certificate.round}`)?.proposal;
            const tx = this.bftTransactions.get(certificate.blockId);
            if (tx) {
              if (!committedProposal || committedProposal.blockId !== certificate.blockId) return send(res, 400, { error: "BFT_COMMIT_PROPOSAL_MISSING" });
              await this.applyBftCommit(committedProposal, certificate, tx);
            } else {
              kernel.recordCommit(certificate);
            }
            return send(res, 200, { accepted: true, applied: !!tx, height: certificate.height, round: certificate.round, blockId: certificate.blockId, stateRoot: this.ledger.stateRoot().toHex() });
          }
        }
        if (req.method === "POST" && url.pathname === "/propose") {
          const result = await this.propose(deserializeTx(body.tx as WireTx));
          return send(res, 200, result);
        }
        if (req.method === "POST" && url.pathname === "/tx") {
          const tx = deserializeTx(body.tx as WireTx);
          const nullifiers = txNullifiers(tx);
          if (nullifiers.some((id) => this.ledger.hasCommittedNullifier(id))) return send(res, 400, { error: "NULLIFIER_SPENT" });
          // A vote is remembered per nullifier and never released, so a spend this ledger would reject gets no vote.
          const checked = this.ledger.validateSpend(tx);
          if ("error" in checked) return send(res, 400, { error: checked.error.code });
          this.txs.set(tx.txId.toHex(), tx);
          const vote = this.quorum.vote(this.id, tx.txId.toHex(), nullifiers.map((id) => id.toHex()), this.privateKey);
          this.saveQuorum();
          return send(res, 200, { txId: tx.txId.toHex(), vote });
        }
        if (req.method === "POST" && url.pathname === "/vote") {
          const tx = this.txs.get(String(body.txId));
          if (!tx) return send(res, 404, { error: "TX_UNKNOWN" });
          const vote = this.quorum.vote(this.id, tx.txId.toHex(), txNullifiers(tx).map((id) => id.toHex()), this.privateKey);
          this.saveQuorum();
          return send(res, 200, vote);
        }
        if (req.method === "POST" && url.pathname === "/commit") {
          const tx = this.txs.get(String(body.txId));
          if (!tx) return send(res, 404, { error: "TX_UNKNOWN" });
          const nullifiers = txNullifiers(tx).map((id) => id.toHex());
          const applied = await this.enqueue(() => {
            const votes = this.quorum.confirm(tx.txId.toHex(), nullifiers, body.votes as QuorumVote[]);
            const result = this.ledger.submit(tx);
            if (!("error" in result)) this.quorum.markSpent(tx.txId.toHex(), nullifiers, votes);
            this.saveQuorum();
            return result;
          });
          if ("error" in applied) return send(res, 400, applied.error);
          return send(res, 200, { txId: tx.txId.toHex(), stateRoot: this.ledger.stateRoot().toHex() });
        }
        send(res, 404, { error: "NOT_FOUND" });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "PEER_ERROR";
        const status = msg === "PAYLOAD_TOO_LARGE" ? 413 : 400;
        send(res, status, { error: msg });
      }
    });
    return new Promise((resolve) => this.server!.listen(port, "127.0.0.1", () => {
      const address = this.server!.address();
      resolve(typeof address === "object" && address ? address.port : port);
    }));
  }

  async learnPeers(): Promise<number> {
    let known = 1;
    for (let attempt = 0; attempt < 10 && known < this.peers.length + 1; attempt++) {
      known = 1;
      for (const peer of this.peers) {
        const status = await get(peer.url + "/status");
        if (status?.publicKeyHex && status.id === peer.id) {
          const announced = String(status.publicKeyHex);
          if (peer.publicKeyHex && peer.publicKeyHex !== announced) continue;
          if (this.quorum.setVoter(peer.id, announced)) known += 1;
        } else if (peer.publicKeyHex && this.knownVoter(peer.id) === peer.publicKeyHex) {
          known += 1;
        }
      }
      if (known < this.peers.length + 1) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return known;
  }

  async propose(tx: UepTransaction): Promise<{ txId: string; votes: number; stateRoot: string }> {
    const txId = tx.txId.toHex();
    const nullifiers = txNullifiers(tx).map((id) => id.toHex());
    const checked = this.ledger.validateSpend(tx);
    if ("error" in checked) throw new Error(checked.error.code);
    this.txs.set(txId, tx);
    const wire = JSON.parse(JSON.stringify(serializeTx(tx), encode));
    const mine = this.quorum.vote(this.id, txId, nullifiers, this.privateKey);
    this.saveQuorum();
    let remote = await votesUntil(this.peers, this.signed("/tx", { tx: wire }), 1);
    for (let attempt = 0; remote.length < 1 && attempt < 3; attempt++) remote = await votesUntil(this.peers, this.signed("/tx", { tx: wire }), 1);
    const accepted = this.quorum.confirm(txId, nullifiers, [mine, ...remote]);
    const acks = (await Promise.all(this.peers.map((peer) => postRetry(peer.url + "/commit", this.signed("/commit", { txId, votes: accepted }))))).filter(Boolean).length;
    if (this.peers.length > 0 && acks < this.threshold - 1) throw new Error("COMMIT_NOT_ACKED");
    await this.enqueue(() => {
      const applied = this.ledger.submit(tx);
      if ("error" in applied) throw new Error(applied.error.code);
      this.quorum.markSpent(txId, nullifiers, accepted);
      this.saveQuorum();
    });
    return { txId, votes: accepted.length, stateRoot: this.ledger.stateRoot().toHex() };
  }

  private enqueue<T>(fn: () => T): Promise<T> {
    const run = this.applyChain.then(() => new Promise<T>((resolve, reject) => setImmediate(() => {
      try { resolve(fn()); } catch (error) { reject(error); }
    })));
    this.applyChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async catchUp(trust: { authorities: string[]; faucetPublicKeys?: string[] }, keys: { snapshotSigningKeys: import("../core/ed25519.ts").PrivateKeyLike[]; faucetSigningKey?: import("../core/ed25519.ts").PrivateKeyLike } = { snapshotSigningKeys: [] }): Promise<boolean> {
    const statuses = await Promise.all(this.peers.map(async (peer) => ({ peer, status: await get(peer.url + "/status") })));
    const mine = this.ledger.stateRoot().toHex();
    const height = this.ledger.height;
    const txCount = this.ledger.txs.length;
    const ahead = statuses
      .filter((item) => item.status && item.status.stateRoot && item.status.stateRoot !== mine)
      .filter((item) => Number(item.status!.height) > height || (Number(item.status!.height) === height && Number(item.status!.txCount) > txCount))
      .sort((a, b) => Number(b.status!.height) - Number(a.status!.height) || Number(b.status!.txCount) - Number(a.status!.txCount))[0];
    if (!ahead) return false;
    try {
      const raw = await fetch(ahead.peer.url + "/snapshot", { signal: AbortSignal.timeout(15000) }).then((res) => res.text());
      const snap = JSON.parse(raw, (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v);
      const { UepLedger } = await import("../testnet/ledger.ts");
      this.ledger = UepLedger.restore(snap, trust, keys);
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body, encode);
  res.writeHead(status, {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  res.end(raw);
}

function readJson(req: import("node:http").IncomingMessage, limit = MAX_PEER_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (chunk) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      n += b.length;
      if (n > limit) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(b);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}", decode) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function votesUntil(peers: Peer[], body: unknown, need: number): Promise<QuorumVote[]> {
  const votes: QuorumVote[] = [];
  return new Promise((resolve) => {
    if (need <= 0 || peers.length === 0) return resolve(votes);
    let pending = peers.length;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(votes); } };
    for (const peer of peers) {
      post(peer.url + "/tx", body).then((reply) => {
        const vote = reply?.vote as QuorumVote | undefined;
        if (vote?.signature) votes.push(vote);
        pending -= 1;
        if (votes.length >= need || pending === 0) finish();
      });
    }
  });
}

async function postRetry(url: string, body: unknown): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await post(url, body);
    if (reply && !reply.error) return reply;
  }
  return undefined;
}

async function post(url: string, body: unknown): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body, encode),
      signal: AbortSignal.timeout(15000),
    });
    return await res.json() as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function get(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return await res.json() as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
