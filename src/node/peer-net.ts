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
import { BftConsensusKernel, type BftCertificate, type BftProposal, type BftRoundChange, type BftRoundChangeCertificate, type BftVote } from "./bft-consensus.ts";
import { randomBytes } from "node:crypto";
import { HeightFloor } from "./height-floor.ts";
import { EquivocationEvidenceStore, makeEquivocationEvidence, verifyEquivocationEvidence, type EquivocationEvidence } from "./bft-equivocation.ts";
import { BftRoundTimer, type RoundTimerConfig } from "./bft-round-timer.ts";
import { PEER_ENVELOPE_LIMITS, PeerKeyRegistry, PeerReplayGuard, signPeerEnvelope, type KeyStatement, type PeerEnvelopeV2 } from "./peer-envelope.ts";
import { CertifiedCommitter, CommitLog, migrateJournalV1, txFromWire, type CommitResult, type CommitStatus, type CommitterOptions } from "./certified-commit.ts";

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
/** 0.5.81 item 9: connection limits, timeouts and backpressure for the peer HTTP server. */
export const PEER_SERVER_LIMITS = Object.freeze({ maxConnections: 256, maxInFlight: 64, headersTimeoutMs: 10_000, requestTimeoutMs: 20_000, keepAliveTimeoutMs: 5_000 });
const NODE_VERSION = "0.5.82";

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
  /** 0.5.83 Block C crash-test hook (after a torn log line reached the disk). */
  commitAfterTornWrite?: () => void;
  /** 0.5.81 item 9: v1 (unbound, replayable) envelopes are accepted while ledger.height < this. Default: always (deprecated, warns once). */
  legacyEnvelopeUntilHeight = Number.POSITIVE_INFINITY;
  private legacyWarned = false;
  private readonly bootId = randomBytes(8).toString("hex");
  private envelopeSeq = 0;
  private replayGuard?: PeerReplayGuard;
  private keyRegistry?: PeerKeyRegistry;
  private inFlight = 0;
  /** 0.5.81 item 3: height-based round-change timer and the round changes seen per `height:targetRound`. */
  private roundTimer = new BftRoundTimer();
  private readonly roundChanges = new Map<string, Map<string, BftRoundChange>>();
  private lastTick = 0;
  /** 0.5.83 Block B: persisted leader-equivocation evidence. */
  private evidencePath?: string;
  private evidence = new EquivocationEvidenceStore();
  /** 0.5.83: the proposal this validator signed per `height:round` (re-sent unchanged on retry). */
  private readonly ownProposals = new Map<string, { proposal: BftProposal }>();
  /** 0.5.81 item 4: own persisted height floor (only with a state directory). */
  readonly heightFloor?: HeightFloor;

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
      this.evidencePath = join(stateDir, "bft-equivocation-evidence.jsonl");
      this.heightFloor = new HeightFloor(stateDir);
      this.heightFloor.check(ledger, { allowRegression: process.env.UEP_ALLOW_HEIGHT_REGRESSION === "1" });
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
    this.evidence = new EquivocationEvidenceStore(this.evidencePath, kernel);
    // H1: one durable, hash-chained commit log per node; the 0.5.80 JSON journal is migrated once.
    const log = new CommitLog(this.commitLogPath ?? null);
    if (this.bftJournalPath && existsSync(this.bftJournalPath)) {
      migrateJournalV1(this.bftJournalPath, log);
      renameSync(this.bftJournalPath, this.bftJournalPath + ".migrated");
    }
    this.committer = new CertifiedCommitter(log, kernel, () => this.ledger, { faultInjector: (p) => this.commitFaultInjector?.(p), afterTornWrite: () => this.commitAfterTornWrite?.() });
  }

  /** Use another round-change timeout (ticks are producer heights). */
  configureRoundTimer(config: RoundTimerConfig): void { this.roundTimer = new BftRoundTimer(config); }

  /** The BFT height this node is waiting to decide. */
  bftOpenHeight(): number { return this.requireCommitter().expectedHeight(); }

  /** Current round of the open height according to the timer. */
  bftRound(): number { return this.roundTimer.current().height === this.bftOpenHeight() ? this.roundTimer.current().round : 0; }

  /**
   * 0.5.81 item 3: feed one producer tick. If the open height timed out in its round, sign a round
   * change to the next round, keep it and send it to every peer. Returns the round change sent, if any.
   */
  async bftTick(tick: number): Promise<BftRoundChange | undefined> {
    const kernel = this.requireBft();
    this.lastTick = tick;
    const height = this.bftOpenHeight();
    const target = this.roundTimer.onTick(tick, height);
    if (target === undefined) {
      // 0.5.83 Block B: re-send our round change for the current round every baseTicks ticks, so a peer
      // that lost it (drops, partition, restart) can still assemble the round-change certificate.
      const round = this.bftRound();
      const mine = round >= 1 ? this.roundChanges.get(`${height}:${round}`)?.get(this.id) : undefined;
      if (mine && tick % this.roundTimer.config.baseTicks === 0) {
        await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/round-change", () => this.signed("/bft/round-change", { roundChange: mine }))));
      }
      return undefined;
    }
    return this.sendRoundChange(kernel, height, target);
  }

  private async sendRoundChange(kernel: BftConsensusKernel, height: number, target: number): Promise<BftRoundChange> {
    const rc = kernel.createRoundChange(height, target, this.id, this.privateKey);
    this.keepRoundChange(rc);
    await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/round-change", () => this.signed("/bft/round-change", { roundChange: rc }))));
    return rc;
  }

  private keepRoundChange(rc: BftRoundChange): void {
    const key = `${rc.height}:${rc.targetRound}`;
    let m = this.roundChanges.get(key);
    if (!m) { m = new Map(); this.roundChanges.set(key, m); }
    if (!m.has(rc.validatorId)) m.set(rc.validatorId, rc);
    // Forget positions of decided heights.
    const open = this.committer ? this.committer.expectedHeight() : 0;
    for (const k of this.roundChanges.keys()) if (Number(k.split(":")[0]) < open) this.roundChanges.delete(k);
  }

  /** Round-change certificate for (height, round) if a quorum of round changes was seen. */
  bftRoundChangeCertificate(height: number, round: number): BftRoundChangeCertificate | undefined {
    const m = this.roundChanges.get(`${height}:${round}`);
    if (!m) return undefined;
    try { return this.requireBft().roundChangeCertificate(height, round, [...m.values()]); } catch { return undefined; }
  }

  /**
   * Leader of (open height, round >= 1) proposes with the round-change certificate. The block is
   * the one the certificate forces (highest lock), else `tx`.
   */
  async bftProposeAfterRoundChange(tx: UepTransaction): Promise<BftCertificate> {
    const kernel = this.requireBft();
    const height = this.bftOpenHeight();
    const round = this.bftRound();
    // 0.5.83 Block B: a leader never signs two different blocks for one round. A retry (no quorum yet)
    // re-sends the identical proposal (same core, same certificate, deterministic signature).
    const own = this.ownProposals.get(`${height}:${round}`);
    if (own) {
      if (own.proposal.blockId !== tx.txId.toHex()) throw new Error("BFT_ALREADY_PROPOSED_OTHER_BLOCK");
      return this.bftPropose(structuredClone(own.proposal), tx);
    }
    const rc = this.bftRoundChangeCertificate(height, round);
    if (round < 1 || !rc) throw new Error("BFT_ROUND_CHANGE_CERTIFICATE_MISSING");
    const required = kernel.requiredProposalFromRoundChanges(rc);
    if (required && required.blockId !== tx.txId.toHex()) throw new Error("BFT_ROUND_CHANGE_REQUIRES_LOCKED_BLOCK");
    const proposal: BftProposal = { networkId: this.ledger.networkId, domainId: this.ledger.domainId, ...(kernel.epoch ? { epoch: kernel.epoch } : {}),
      height, round, proposerId: this.id, parentRoot: this.ledger.stateRoot().toHex(), blockId: tx.txId.toHex(), roundChangeCertificate: rc,
      ...(required ? { validRound: required.validRound, validRoundCertificate: required.validRoundCertificate } : {}) };
    this.assertBftTransaction(proposal, tx);
    this.ownProposals.set(`${height}:${round}`, { proposal: structuredClone(proposal) });
    return this.bftPropose(proposal, tx);
  }

  /** 0.5.83 Block B: equivocation evidence recorded by this validator (persisted). */
  bftEquivocationEvidence(): EquivocationEvidence[] { return this.evidence.all(); }

  /** 0.5.83: transaction known for a block id (from a proposal seen), if any. */
  bftTransaction(blockId: string): UepTransaction | undefined { return this.bftTransactions.get(blockId); }

  /** 0.5.83: leader of (height, round). */
  bftLeader(height: number, round: number): string { return this.requireBft().leader(height, round); }

  /**
   * 0.5.83 Block B: record verified equivocation evidence. New evidence is gossiped to every peer and,
   * when it concerns the open height in this validator's current round, the validator leaves the round
   * at once (round change to round + 1) instead of waiting for the timeout. Returns true when new.
   */
  async bftRecordEquivocation(ev: EquivocationEvidence): Promise<boolean> {
    const kernel = this.requireBft();
    if (!verifyEquivocationEvidence(kernel, ev)) throw new Error("BFT_EQUIVOCATION_EVIDENCE_INVALID");
    if (!this.evidence.add(ev)) return false;
    console.warn(`[uep-peer] BFT_LEADER_EQUIVOCATION proposer=${ev.proposerId} height=${ev.height} round=${ev.round}`);
    void Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/equivocation", () => this.signed("/bft/equivocation", { evidence: ev })))).catch(() => {});
    const height = this.bftOpenHeight();
    if (ev.height === height && ev.round >= this.bftRound()) {
      const target = ev.round + 1;
      if (this.roundTimer.join(height, target, this.lastTick) || this.bftRound() === target) {
        try { await this.sendRoundChange(kernel, height, target); } catch { /* locked beyond this round: the timer continues */ }
      }
    }
    return true;
  }

  /** Compare a proposal seen elsewhere with ours for its position; conflicting signed proposals become evidence. */
  private async checkProposalConflict(proposal: BftProposal, signature: string): Promise<boolean> {
    const prior = this.bftProposals.get(this.bftPosition(proposal));
    if (!prior || prior.proposal.proposerId !== proposal.proposerId || prior.proposal.blockId === proposal.blockId) return false;
    return this.bftRecordEquivocation(makeEquivocationEvidence(prior, { proposal, signature }));
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
    const replies = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/proposal", () => this.signed("/bft/proposal", { proposal, proposalSignature: signature, ...(wireTx ? { tx: wireTx } : {}) }))));
    const prevotes = [mine, ...replies.map(reply => reply?.vote as BftVote | undefined).filter((vote): vote is BftVote => !!vote)];
    const prevoteCertificate = kernel.voteCertificate(proposal.height, proposal.round, "prevote", proposal.blockId, prevotes);
    kernel.observePrevoteCertificate(prevoteCertificate);

    // The certificate is part of the signed precommit proposal; validators never
    // accept a precommit based on an unsigned or mismatched certificate.
    const lockedProposal: BftProposal = { ...proposal, prevoteCertificate };
    const lockedSignature = kernel.signProposal(lockedProposal, this.privateKey);
    this.bftProposals.set(this.bftPosition(lockedProposal), { proposal: structuredClone(lockedProposal), signature: lockedSignature });
    const localPrecommit = kernel.createVote(lockedProposal, "precommit", this.id, this.privateKey, lockedSignature);
    const lockReplies = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/prevote-certificate", () => this.signed("/bft/prevote-certificate", { proposal: lockedProposal, proposalSignature: lockedSignature, certificate: prevoteCertificate }))));
    const precommits = [localPrecommit, ...lockReplies.map(reply => reply?.vote as BftVote | undefined).filter((vote): vote is BftVote => !!vote)];
    const commitCertificate = kernel.voteCertificate(proposal.height, proposal.round, "precommit", proposal.blockId, precommits);
    if (tx) await this.applyBftCommit(lockedProposal, commitCertificate, tx);
    else kernel.recordCommit(commitCertificate);
    // The commit message carries the signed proposal and the transaction, so a validator that missed
    // the proposal can still apply through applyCertifiedCommit (it re-verifies everything).
    const commitPayload = { certificate: commitCertificate, proposal: lockedProposal, proposalSignature: lockedSignature, ...(wireTx ? { tx: wireTx } : {}) };
    const commits = await Promise.all(this.peers.map(peer => postRetry(peer.url + "/bft/commit-certificate", () => this.signed("/bft/commit-certificate", commitPayload))));
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

  /**
   * Catch up from peers: fetch certified commits from the next expected height and apply each
   * through applyCertifiedCommit. Nothing from a peer is trusted: certificate, proposal signature,
   * height, parent root and spend are all re-checked locally. Returns the number of heights applied.
   */
  async bftSync(): Promise<number> {
    const committer = this.requireCommitter();
    let applied = 0;
    for (const peer of this.peers) {
      for (;;) {
        const reply = await get(`${peer.url}/bft/commits?from=${committer.expectedHeight()}`);
        const list = Array.isArray(reply?.commits) ? reply!.commits as Array<{ proposal: BftProposal; proposalSignature: string; certificate: BftCertificate; tx: WireTx }> : [];
        let progressed = false;
        for (const c of list) {
          if (c.proposal?.height !== committer.expectedHeight()) continue;
          try {
            const tx = txFromWire(c.tx);
            await this.enqueue(() => committer.applyCertifiedCommit({ proposal: c.proposal, proposalSignature: c.proposalSignature, certificate: c.certificate, tx }));
            this.bftProposals.set(this.bftPosition(c.proposal), { proposal: structuredClone(c.proposal), signature: c.proposalSignature });
            applied++; progressed = true;
          } catch { break; }
        }
        if (!progressed) break;
      }
    }
    return applied;
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

  private peerDomain() {
    return { networkId: this.ledger.networkId, domainId: this.ledger.domainId, epoch: this.bftKernel?.epoch ?? 0 };
  }

  private guard(): PeerReplayGuard {
    const d = this.peerDomain();
    if (!this.replayGuard || this.replayGuard.domain.epoch !== d.epoch) this.replayGuard = new PeerReplayGuard(d);
    return this.replayGuard;
  }

  /** Peer key at a height: the verified rotation/revocation registry when it knows the peer, else the pinned voter key. */
  peerKeyAt(id: string, height: number): string | undefined {
    if (this.keyRegistry && this.keyRegistry.keyAt(id, 0) !== undefined) return this.keyRegistry.keyAt(id, height);
    return this.knownVoter(id);
  }

  /** 0.5.81 item 9: apply a verifiable key rotation or revocation (old key + threshold validators, or threshold validators). */
  applyPeerKeyStatement(st: KeyStatement): void {
    if (!this.keyRegistry) {
      const voters = (this.quorum as unknown as { voters: Map<string, string> }).voters;
      this.keyRegistry = new PeerKeyRegistry(this.ledger.networkId, new Map(voters), this.threshold);
    }
    this.keyRegistry.apply(st, this.ledger.height);
  }

  private signed(path: string, payload: unknown): Record<string, unknown> {
    // 0.5.81 item 9: v2 envelope bound to network, domain, epoch and height, with a one-time nonce.
    return signPeerEnvelope(this.peerDomain(), this.id, path, this.ledger.height, `${this.bootId}-${++this.envelopeSeq}`, payload, this.privateKey) as unknown as Record<string, unknown>;
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
      let counted = false;
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const ip = req.socket.remoteAddress ?? "unknown";
        if (!this.rateOk(ip)) return send(res, 429, { error: "RATE_LIMITED" });
        if (this.inFlight >= PEER_SERVER_LIMITS.maxInFlight) return send(res, 503, { error: "BUSY" });
        this.inFlight++; counted = true;
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
        if (req.method === "GET" && url.pathname === "/bft/commits" && this.committer) {
          const from = Math.max(0, Number(url.searchParams.get("from") ?? 0) | 0);
          const out = [];
          for (const e of this.committer.log.all()) {
            if (e.type !== "INTENT" || e.height < from || this.committer.status(e.height) !== "APPLIED") continue;
            out.push({ proposal: e.proposal, proposalSignature: e.proposalSignature, certificate: e.certificate, tx: e.tx });
            if (out.length >= 64) break;
          }
          return send(res, 200, { commits: out });
        }
        if (req.method === "GET" && url.pathname === "/txs") {
          const txs = this.ledger.txs.slice(-20).map((tx) => tx.txId.toHex());
          return send(res, 200, { id: this.id, height: this.ledger.height, stateRoot: this.ledger.stateRoot().toHex(), txCount: this.ledger.txs.length, recent: txs });
        }
        const raw = await readJson(req);
        const peerPaths = new Set(["/tx", "/vote", "/commit", "/bft/proposal", "/bft/prevote-certificate", "/bft/commit-certificate", "/bft/round-change", "/bft/proposal-seen", "/bft/equivocation"]);
        let body = raw;
        let authenticatedFrom: string | undefined;
        if (req.method === "POST" && peerPaths.has(url.pathname)) {
          const from = String(raw.from ?? "");
          authenticatedFrom = from;
          if (raw.v === 2) {
            try {
              this.guard().verify(raw as unknown as PeerEnvelopeV2, url.pathname, this.ledger.height, (id, h) => this.peerKeyAt(id, h));
            } catch (e) {
              const code = e instanceof Error ? e.message : "PEER_AUTH";
              console.error(`[uep-peer] ${code} from=${from} path=${url.pathname} ip=${ip}`);
              return send(res, code === "PEER_REPLAY" ? 409 : 401, { error: code });
            }
          } else {
            if (this.ledger.height >= this.legacyEnvelopeUntilHeight) return send(res, 401, { error: "PEER_ENVELOPE_V1_RETIRED" });
            if (!this.legacyWarned) { this.legacyWarned = true; console.warn("[uep-peer] UEP_DEP_PEER_ENVELOPE_V1: accepted an unbound v1 peer envelope; set legacyEnvelopeUntilHeight to retire v1 (removed in 0.6.0)"); }
            const expected = this.peerKeyAt(from, this.ledger.height);
            const message = `uep-peer:${from}:${url.pathname}:${JSON.stringify(raw.payload)}`;
            if (!expected || !verifyEd25519(message, String(raw.signature ?? ""), expected)) {
              console.error(`[uep-peer] PEER_AUTH failed from=${from} path=${url.pathname} ip=${ip}`);
              return send(res, 401, { error: "PEER_AUTH" });
            }
          }
          body = raw.payload as Record<string, unknown>;
        }
        if (req.method === "POST" && url.pathname.startsWith("/bft/")) {
          const kernel = this.requireBft();
          if (!authenticatedFrom) return send(res, 401, { error: "PEER_AUTH" });
          if (url.pathname === "/bft/round-change") {
            const rc = body.roundChange as BftRoundChange;
            if (!rc || rc.validatorId !== authenticatedFrom || !kernel.verifyRoundChange(rc)) return send(res, 400, { error: "BFT_ROUND_CHANGE_INVALID" });
            if (rc.height !== this.bftOpenHeight()) return send(res, 200, { accepted: false, reason: "NOT_OPEN_HEIGHT" });
            this.keepRoundChange(rc);
            // f + 1 round changes for a higher round: at least one honest validator timed out, so join it.
            const seen = this.roundChanges.get(`${rc.height}:${rc.targetRound}`)?.size ?? 0;
            if (seen >= kernel.faultTolerance + 1 && rc.targetRound > this.bftRound() && this.roundTimer.join(rc.height, rc.targetRound, this.lastTick)) {
              try { await this.sendRoundChange(kernel, rc.height, rc.targetRound); } catch { /* locked beyond this round: keep waiting */ }
            }
            return send(res, 200, { accepted: true });
          }
          if (url.pathname === "/bft/proposal") {
            const proposal = body.proposal as BftProposal;
            const proposalSignature = String(body.proposalSignature ?? "");
            if (!proposal || proposal.proposerId !== authenticatedFrom || !kernel.verifyProposal(proposal, proposalSignature)) {
              return send(res, 400, { error: "BFT_PROPOSAL_AUTH_INVALID" });
            }
            const key = this.bftPosition(proposal);
            const prior = this.bftProposals.get(key);
            if (prior && (prior.proposal.blockId !== proposal.blockId || prior.signature !== proposalSignature)) {
              // 0.5.83: keep the proof and leave the round.
              if (prior.proposal.blockId !== proposal.blockId) await this.checkProposalConflict(proposal, proposalSignature).catch(() => false);
              return send(res, 409, { error: "BFT_PROPOSAL_EQUIVOCATION" });
            }
            if (body.tx !== undefined) {
              const tx = deserializeTx(body.tx as WireTx);
              this.assertBftTransaction(proposal, tx);
              this.bftTransactions.set(proposal.blockId, tx);
            }
            this.bftProposals.set(key, { proposal: structuredClone(proposal), signature: proposalSignature });
            const vote = kernel.createVote(proposal, "prevote", this.id, this.privateKey, proposalSignature);
            // 0.5.83 Block B: tell the other validators which signed proposal we saw (detects a split equivocation).
            void Promise.all(this.peers.filter(p => p.id !== proposal.proposerId).map(peer => postRetry(peer.url + "/bft/proposal-seen", () => this.signed("/bft/proposal-seen", { proposal, proposalSignature })))).catch(() => {});
            return send(res, 200, { accepted: true, vote });
          }
          if (url.pathname === "/bft/proposal-seen") {
            const proposal = body.proposal as BftProposal;
            const proposalSignature = String(body.proposalSignature ?? "");
            if (!proposal || !kernel.verifyProposal(proposal, proposalSignature)) return send(res, 400, { error: "BFT_PROPOSAL_AUTH_INVALID" });
            const evidence = await this.checkProposalConflict(proposal, proposalSignature);
            return send(res, 200, { accepted: true, evidence });
          }
          if (url.pathname === "/bft/equivocation") {
            try { return send(res, 200, { accepted: true, new: await this.bftRecordEquivocation(body.evidence as EquivocationEvidence) }); }
            catch { return send(res, 400, { error: "BFT_EQUIVOCATION_EVIDENCE_INVALID" }); }
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
            const carried = body.proposal as BftProposal | undefined;
            const carriedSig = typeof body.proposalSignature === "string" ? body.proposalSignature : undefined;
            if (carried && carriedSig && carried.blockId === certificate.blockId && kernel.verifyProposal(carried, carriedSig)) {
              const position = this.bftPosition(carried);
              const prior = this.bftProposals.get(position);
              if (!prior || prior.proposal.blockId === carried.blockId) this.bftProposals.set(position, { proposal: structuredClone(carried), signature: carriedSig });
            }
            if (body.tx !== undefined && !this.bftTransactions.has(certificate.blockId)) {
              const carriedTx = deserializeTx(body.tx as WireTx);
              if (carriedTx.txId.toHex() === certificate.blockId) this.bftTransactions.set(certificate.blockId, carriedTx);
            }
            const committedProposal = this.bftProposals.get(`${certificate.height}:${certificate.round}`)?.proposal;
            const tx = this.bftTransactions.get(certificate.blockId);
            let applied = false;
            if (tx) {
              if (!committedProposal || committedProposal.blockId !== certificate.blockId) return send(res, 400, { error: "BFT_COMMIT_PROPOSAL_MISSING" });
              try {
                await this.applyBftCommit(committedProposal, certificate, tx);
                applied = true;
              } catch (error) {
                const code = (error as Error).message;
                // A lagging validator keeps the certificate (CERTIFIED_NOT_APPLIED) and catches up with bftSync().
                if (code === "BFT_HEIGHT_MISMATCH" || code === "BFT_PARENT_STATE_MISMATCH") kernel.recordCommit(certificate);
                else return send(res, 409, { error: code });
              }
            } else {
              kernel.recordCommit(certificate);
            }
            return send(res, 200, { accepted: true, applied, height: certificate.height, round: certificate.round, blockId: certificate.blockId, stateRoot: this.ledger.stateRoot().toHex() });
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
      } finally {
        if (counted) this.inFlight--;
      }
    });
    this.server.maxConnections = PEER_SERVER_LIMITS.maxConnections;
    this.server.headersTimeout = PEER_SERVER_LIMITS.headersTimeoutMs;
    this.server.requestTimeout = PEER_SERVER_LIMITS.requestTimeoutMs;
    this.server.keepAliveTimeout = PEER_SERVER_LIMITS.keepAliveTimeoutMs;
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
    const acks = (await Promise.all(this.peers.map((peer) => postRetry(peer.url + "/commit", () => this.signed("/commit", { txId, votes: accepted }))))).filter(Boolean).length;
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
      // Item 4 (0.5.81): a peer snapshot may only extend what this node already has. The height floor
      // forbids rollback; the transaction history and every BFT-applied transaction must be a prefix.
      const floor = this.heightFloor?.read()?.height ?? 0;
      const next = UepLedger.restore(snap, trust, keys, { minHeight: Math.max(this.ledger.height, floor) });
      if (!extendsHistory(this.ledger, next, this.committer)) return false;
      this.heightFloor?.check(next, { heightOnly: true });
      this.ledger = next;
      this.heightFloor?.record(next);
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

/** `body` may be a factory: each attempt then gets a freshly signed envelope (new nonce), so a retry is never refused as a replay. */
async function postRetry(url: string, body: unknown): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await post(url, typeof body === "function" ? (body as () => unknown)() : body);
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

/** True iff `next` keeps every transaction of `current` in the same order and contains every BFT-applied transaction. */
export function extendsHistory(current: UepLedger, next: UepLedger, committer?: CertifiedCommitter): boolean {
  if (next.height < current.height || next.txs.length < current.txs.length) return false;
  for (let i = 0; i < current.txs.length; i++) if (next.txs[i]!.txId.toHex() !== current.txs[i]!.txId.toHex()) return false;
  if (next.mints.length < current.mints.length) return false;
  if (committer) {
    const have = new Set(next.txs.map(tx => tx.txId.toHex()));
    for (const e of committer.log.all()) if (e.type === "APPLIED" && !have.has(e.blockId)) return false;
  }
  return true;
}
