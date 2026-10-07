/**
 * UEP-38.29 — One OS process = one P4 replica. Apply waits for a 3-of-4 P4 spend certificate.
 * Control: JSON lines on stdin. Data: TCP P4_PROPOSAL/VOTE/COMMIT.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { KeyObject } from "node:crypto";
import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";
import { TcpMeshEndpoint } from "./uep35-tcp-mesh.ts";
import {
  sealConsensusMsg,
  verifyConsensusMsg,
  type ConsensusEnvelope,
} from "./uep35-consensus-msg.ts";
import { verifyP4SpendCert, signP4Spend, type P4SpendCert } from "./uep38-p4-spend-cert.ts";
import { LAB_PROFILE } from "./uep-network-profile.ts";
import { assertPinnedVk, labAuthBodyFromArtifact, signSenderAuth, verifySenderAuth } from "./uep38-apply-guards.ts";
import { Fr } from "../core/field.ts";
import {
  bindCircuitAccounts,
  defaultAlignedAccounts,
  proveWithoutApply,
  proveTwoParallel,
  proveManyParallel,
  carolAlignedAccounts,
  erinAlignedAccounts,
  labParty,
} from "./uep38-zk-state-transition.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { canonicalSpendId, claimFreshNullifier, nodeApplyVerifiedTransfer, p4PinnedVk, verifyArtifactAgainstRoots } from "./uep38-node-verify.ts";
import {
  deserializeStagingArtifact,
  serializeStagingArtifact,
} from "./uep38-p4-staging.ts";
import type { ProposalPayload } from "./uep35-consensus-msg.ts";
import { HeightVoteLock } from "./uep36-aggregate-semantics.ts";
import { scheduledLeader } from "./uep37-leader-schedule.ts";
import {
  assembleViewChangeQC,
  signViewChangeVote,
  type ViewChangeVote,
  type ViewChangeTarget,
} from "./uep37-view-change-qc.ts";

/** v0.5.3: `view` is the view the leader proposes in (absent = view 0, earlier proposals). */
type P4ProposalExtra = ProposalPayload & { amount: string; zkSpend: string; view?: number };
type P4Vote = { nodeId: string; digest: string; signature: string };
function p4VoteBody(digest: string, height: number, epoch = 1, view = 0): string {
  return `UEP-38.21-P4-VOTE|${LAB_PROFILE.networkId}|${epoch}|${view}|${height}|${digest}`;
}
function p4ViewTarget(height: number, nextView: number, anchorRoot: string): ViewChangeTarget {
  return {
    networkId: LAB_PROFILE.networkId,
    domainId: LAB_PROFILE.domainNumber,
    epoch: 1,
    height,
    nextView,
    reason: "SILENT_LEADER_TIMEOUT",
    anchorRoot,
  };
}

export const P4_PROCESS_VERSION = "38.35";

export type P4BootNode = {
  id: string;
  publicKeyHex: string;
  privateKeyHex?: string;
};
export type P4Bootstrap = { nodes: P4BootNode[] };

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

export function generateP4Bootstrap(n: number): P4Bootstrap {
  const nodes: P4BootNode[] = [];
  for (let i = 0; i < n; i++) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    nodes.push({
      id: `p4-${i}`,
      publicKeyHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
      privateKeyHex: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
    });
  }
  return { nodes };
}

export class P4ProcessRuntime {
  readonly id: string;
  readonly identity: NodeIdentity;
  readonly pubkeys = new Map<string, string>();
  readonly mesh: TcpMeshEndpoint;
  readonly dialBook = new Map<string, number>();
  readonly state: SmtEconomicState;
  readonly ids = defaultAlignedAccounts();
  votesByDigest = new Map<string, P4Vote[]>();
  earlyVotes = new Map<string, P4Vote[]>();
  envByDigest = new Map<string, ConsensusEnvelope>();
  commitLog: { env: ConsensusEnvelope; votes: P4Vote[] }[] = [];
  pendingCommits: { env: ConsensusEnvelope; votes: P4Vote[] }[] = [];
  get lastCommit(): { env: ConsensusEnvelope; votes: P4Vote[] } | null {
    return this.commitLog.length ? this.commitLog[this.commitLog.length - 1]! : null;
  }
  appliedHeights = new Set<number>();
  spentNullifiers = new Set<string>();
  lastError: string | null = null;
  dataDir: string | null = null;
  readonly heightLock = new HeightVoteLock();

  constructor(boot: P4Bootstrap, nodeId: string, depth: 4 | 32 = 4, dataDir?: string) {
    this.id = nodeId;
    const self = boot.nodes.find((n) => n.id === nodeId);
    if (!self?.privateKeyHex) throw new Error("no key");
    this.identity = identityFromHex(nodeId, self.privateKeyHex, self.publicKeyHex);
    for (const n of boot.nodes) this.pubkeys.set(n.id, n.publicKeyHex);
    this.mesh = new TcpMeshEndpoint(nodeId);
    const carolOn = process.env.UEP_P4_CAROL === "1";
    const erinOn = process.env.UEP_P4_ERIN === "1";
    this.state = SmtEconomicState.genesis(
      carolOn
        ? { alice: 10_000n, bob: 0n, carol: 10_000n, dave: 0n, ...(erinOn ? { erin: 10_000n, frank: 0n } : {}) }
        : { alice: 10_000n, bob: 0n },
      { testOnlyDepth: depth, isTestFixture: true, leafMode: "poseidon-zk" },
    );
    bindCircuitAccounts(this.state, this.ids);
    this.mesh.onMessage((_f, kind, payload) => this.onMsg(kind, payload));
    this.dataDir = dataDir && dataDir.length ? dataDir : null;
    if (this.dataDir) mkdirSync(this.dataDir, { recursive: true });
  }

  commitPath(): string | null {
    return this.dataDir ? join(this.dataDir, "commits.jsonl") : null;
  }

  persistCommit(): void {
    const path = this.commitPath();
    if (!path) return;
    const tmp = path + ".tmp";
    const lines = this.commitLog.map((c) => JSON.stringify(c)).join("\n") + (this.commitLog.length ? "\n" : "");
    writeFileSync(tmp, lines);
    writeFileSync(path, readFileSync(tmp));
  }

  loadCommitFromDisk(): boolean {
    const path = this.commitPath();
    if (!path || !existsSync(path)) return false;
    const text = readFileSync(path, "utf8").trim();
    if (!text) return false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const body = JSON.parse(line) as { env: ConsensusEnvelope; votes: P4Vote[] };
      this.enqueueCommit(body.env, body.votes);
    }
    return this.appliedHeights.size > 0;
  }

  emit(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  private onMsg(kind: string, payload: Uint8Array): void {
    try {
      const text = Buffer.from(payload).toString("utf8");
      if (kind === "P4_PROPOSAL") this.onProposal(JSON.parse(text) as ConsensusEnvelope);
      else if (kind === "P4_VOTE") this.onVote(JSON.parse(text) as P4Vote);
      else if (kind === "P4_COMMIT") {
        const body = JSON.parse(text) as { env: ConsensusEnvelope; votes: P4Vote[] };
        this.enqueueCommit(body.env, body.votes);
      } else if (kind === "P4_VIEW_CHANGE") {
        this.onViewVote(JSON.parse(text) as ViewChangeVote);
      } else if (kind === "P4_CATCHUP_REQ") {
        for (const c of this.commitLog) {
          this.mesh.broadcast("P4_COMMIT", Buffer.from(JSON.stringify(c), "utf8"));
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit({ event: "error", error: this.lastError });
    }
  }

  /**
   * `fresh`: a proposal (not a certified commit). v0.5.3: a fresh proposal must
   * be made in the view this replica has adopted, so a leader of another view
   * cannot claim it; a commit carries a vote quorum and keeps its own view.
   */
  private inspect(env: ConsensusEnvelope, fresh = false): boolean {
    const pk = this.pubkeys.get(env.sender);
    if (!pk || !verifyConsensusMsg(env, pk)) {
      this.lastError = "BAD_ENVELOPE_SIG";
      return false;
    }
    try {
      const view = Number((JSON.parse(env.payload) as { view?: number }).view ?? 0);
      if (fresh && view !== this.view) {
        this.lastError = "VIEW_MISMATCH";
        return false;
      }
      const lead = scheduledLeader(env.height, [...this.pubkeys.keys()], view);
      if (env.sender !== lead) {
        this.lastError = "NOT_LEADER";
        return false;
      }
    } catch {
      this.lastError = "BAD_PAYLOAD";
      return false;
    }
    const p = JSON.parse(env.payload) as P4ProposalExtra & { batch?: { amount: string; zkSpend: string }[] };
    if (p.batch && p.batch.length) {
      let root = this.state.stateRoot();
      for (const item of p.batch) {
        const art = deserializeStagingArtifact(item.zkSpend);
        const v = verifyArtifactAgainstRoots(art, root, art.newRootProof, this.state.depth as 4 | 32);
        if (!v.ok) {
          this.lastError = v.reason;
          return false;
        }
        root = art.newRootProof;
      }
      if (root.toLowerCase() !== String(p.stateRoot).toLowerCase()) {
        this.lastError = "BATCH_ROOT";
        return false;
      }
      return true;
    }
    const art = deserializeStagingArtifact(p.zkSpend);
    const nf = (art.publicInputsHex[10] ?? "").replace(/^0x/i, "").toLowerCase();
    if (nf && this.state.hasNullifier(nf)) {
      this.lastError = "NULLIFIER_REPLAY";
      return false;
    }
    const v = verifyArtifactAgainstRoots(art, this.state.stateRoot(), p.stateRoot, this.state.depth as 4 | 32);
    if (!v.ok) {
      this.lastError = v.reason;
      return false;
    }
    return true;
  }

  private onProposal(env: ConsensusEnvelope): void {
    this.envByDigest.set(env.payloadDigest, env);
    const early = this.earlyVotes.get(env.payloadDigest) ?? [];
    this.earlyVotes.delete(env.payloadDigest);
    if (!this.inspect(env, true)) {
      this.emit({ event: "reject", reason: this.lastError });
      return;
    }
    const lock = this.heightLock.tryLock(env.epoch, env.height, env.payloadDigest, this.id);
    if (!lock.ok) {
      this.lastError = lock.reason ?? "HEIGHT_VOTE_LOCK_CONFLICT";
      this.emit({ event: "reject", reason: this.lastError });
      return;
    }
    const parsed = JSON.parse(env.payload) as { zkSpend?: string; batch?: { zkSpend: string }[]; spendId?: string; batchId?: string };
    const rawArt = parsed.zkSpend || parsed.batch?.[0]?.zkSpend;
    const art = rawArt ? deserializeStagingArtifact(rawArt) : undefined;
    const spendSig = art?.publicInputsHex?.[10]
      ? signP4Spend(this.identity, {
          domainId: LAB_PROFILE.domainId,
          spendId: parsed.spendId ?? parsed.batchId ?? "",
          oldRoot: art.oldRootProof,
          newRoot: art.newRootProof,
          nullifier: art.publicInputsHex[10],
          amount: art.publicInputsHex[8] ?? "",
          fee: art.publicInputsHex[9] ?? "",
          senderId: art.publicInputsHex[4] ?? "",
          recipientId: art.publicInputsHex[5] ?? "",
          treasuryId: art.publicInputsHex[6] ?? "",
          assetId: art.publicInputsHex[7] ?? "",
        }).signature
      : undefined;
    const vote: P4Vote = {
      nodeId: this.id,
      digest: env.payloadDigest,
      signature: signBytes(this.identity, p4VoteBody(env.payloadDigest, env.height, env.epoch, Number((JSON.parse(env.payload) as { view?: number }).view ?? 0))),
      spendCertSig: spendSig,
    };
    this.onVote(vote);
    this.mesh.broadcast("P4_VOTE", Buffer.from(JSON.stringify(vote), "utf8"));
    for (const ev of early) this.onVote(ev);
  }

  private onVote(v: P4Vote): void {
    const env = this.envByDigest.get(v.digest);
    if (!env) {
      const early = this.earlyVotes.get(v.digest) ?? [];
      if (!early.some((x) => x.nodeId === v.nodeId)) early.push(v);
      this.earlyVotes.set(v.digest, early);
      return;
    }
    const list = this.votesByDigest.get(v.digest) ?? [];
    if (list.some((x) => x.nodeId === v.nodeId)) return;
    const pk = this.pubkeys.get(v.nodeId);
    if (!pk) return;
    if (!verifyBytes(pk, p4VoteBody(v.digest, env.height, env.epoch, Number((JSON.parse(env.payload) as { view?: number }).view ?? 0)), v.signature)) return;
    list.push(v);
    this.votesByDigest.set(v.digest, list);
    this.emit({ event: "vote", from: v.nodeId, n: list.length, height: env.height });
    if (list.length >= 3 && !this.appliedHeights.has(env.height)) {
      this.mesh.broadcast(
        "P4_COMMIT",
        Buffer.from(JSON.stringify({ env, votes: list }), "utf8"),
      );
      this.enqueueCommit(env, list);
    }
  }

  private enqueueCommit(env: ConsensusEnvelope, votes: P4Vote[]): void {
    this.pendingCommits.push({ env, votes });
    this.pendingCommits.sort((a, b) => a.env.height - b.env.height);
    let progress = true;
    while (progress) {
      progress = false;
      const next = this.pendingCommits.filter((c) => !this.appliedHeights.has(c.env.height));
      this.pendingCommits = next;
      for (const c of next) {
        const before = this.appliedHeights.size;
        this.applyCommit(c.env, c.votes);
        if (this.appliedHeights.size > before) progress = true;
      }
    }
  }

  private applyCommit(env: ConsensusEnvelope, votes: P4Vote[]): void {
    if (this.appliedHeights.has(env.height)) {
      this.emit({ event: "applied", root: this.state.stateRoot(), dup: true, height: env.height });
      return;
    }
    if (!this.inspect(env)) return;
    const good = votes.filter((v) => {
      const pk = this.pubkeys.get(v.nodeId);
      return !!pk && v.digest === env.payloadDigest &&
        verifyBytes(pk, p4VoteBody(v.digest, env.height, env.epoch, Number((JSON.parse(env.payload) as { view?: number }).view ?? 0)), v.signature);
    });
    const uniq = [...new Map(good.map((v) => [v.nodeId, v])).values()];
    if (uniq.length < 3) {
      this.lastError = `NO_QUORUM:${uniq.length}`;
      return;
    }
    const p = JSON.parse(env.payload) as P4ProposalExtra & { batch?: { amount: string; zkSpend: string; who?: string }[]; spendId?: string; spendCert?: P4SpendCert };
    const rawArt = p.zkSpend || p.batch?.[0]?.zkSpend;
    const artForCert = rawArt ? deserializeStagingArtifact(rawArt) : undefined;
    const spendId = p.spendId ?? p.batchId;
    if (!spendId) {
      this.lastError = "SPEND_ID_REQUIRED";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const cert: P4SpendCert = p.spendCert ?? {
      domainId: LAB_PROFILE.domainId,
      spendId,
      oldRoot: artForCert?.oldRootProof ?? "",
      newRoot: artForCert?.newRootProof ?? "",
      nullifier: artForCert?.publicInputsHex?.[10] ?? "",
      amount: artForCert?.publicInputsHex?.[8] ?? p.amount ?? "",
      fee: artForCert?.publicInputsHex?.[9] ?? "",
      senderId: artForCert?.publicInputsHex?.[4] ?? "",
      recipientId: artForCert?.publicInputsHex?.[5] ?? "",
      treasuryId: artForCert?.publicInputsHex?.[6] ?? "",
      assetId: artForCert?.publicInputsHex?.[7] ?? "",
      votes: votes.filter((v) => v.spendCertSig).map((v) => ({ nodeId: v.nodeId, signature: v.spendCertSig! })),
    };
    if (cert.spendId !== spendId) {
      this.lastError = "SPEND_ID_MISMATCH";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const certOk = verifyP4SpendCert(this.pubkeys, cert);
    if (!certOk.ok) {
      this.lastError = certOk.reason ?? "SPEND_CERT_REQUIRED";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    if (p.batch && p.batch.length) {
      const parties = [this.ids, carolAlignedAccounts()];
      for (let i = 0; i < p.batch.length; i++) {
        const item = p.batch[i]!;
        const art = deserializeStagingArtifact(item.zkSpend);
        const fresh = claimFreshNullifier(this.spentNullifiers, art);
        if (!fresh.ok) {
          this.lastError = fresh.reason ?? "NULLIFIER_REPLAY";
          this.emit({ event: "apply_fail", reason: this.lastError });
          return;
        }
        const have = this.state.stateRoot().replace(/^0x/i, "").toLowerCase();
        if (have === art.newRootProof.replace(/^0x/i, "").toLowerCase()) continue;
        const party = labParty(item.who ?? (i === 0 ? "alice" : "carol"));
        const r = nodeApplyVerifiedTransfer(this.state, party, BigInt(item.amount), art);
        if (!r.ok) {
          this.lastError = r.reason;
          this.emit({ event: "apply_fail", reason: r.reason });
          return;
        }
      }
    } else {
    const art = deserializeStagingArtifact(p.zkSpend);
    // Only the pinned verifying key for this circuit version and depth is accepted.
    let pinned: string;
    try {
      pinned = p4PinnedVk(this.state.depth as 4 | 32);
    } catch {
      this.lastError = "VK_NOT_PINNED";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const vkOk = art.vkHex ? assertPinnedVk(art, pinned) : { ok: true as const, reason: undefined };
    if (!vkOk.ok) {
      this.lastError = vkOk.reason ?? "VK_NOT_PINNED";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const auth = (p as { senderAuth?: { publicKeyHex: string; signature: string } }).senderAuth;
    const body = labAuthBodyFromArtifact(art);
    const expectPub = signSenderAuth(this.ids.senderSecret, body).publicKeyHex;
    if (!auth || auth.publicKeyHex !== expectPub || !verifySenderAuth(expectPub, body, auth.signature)) {
      this.lastError = "SENDER_AUTH_REQUIRED";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const nfHex = (art.publicInputsHex[10] ?? "").replace(/^0x/i, "").toLowerCase();
    if (nfHex.length < 16) {
      this.lastError = "NULLIFIER_MISSING";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    if (this.spentNullifiers.has(nfHex) || this.state.hasNullifier(nfHex)) {
      this.lastError = "NULLIFIER_REPLAY";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    const want = art.newRootProof.replace(/^0x/i, "").toLowerCase();
    const have = this.state.stateRoot().replace(/^0x/i, "").toLowerCase();
    if (have !== want) {
      const r = nodeApplyVerifiedTransfer(this.state, this.ids, BigInt(p.amount), art);
      if (!r.ok) {
        this.lastError = r.reason;
        this.emit({ event: "apply_fail", reason: r.reason });
        return;
      }
    }
    this.spentNullifiers.add(nfHex);
    const nf = this.state.insertNullifier(Fr.from("0x" + nfHex));
    if (!nf.ok && nf.reason !== "NULLIFIER_ALREADY_SPENT") {
      this.lastError = nf.reason;
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    if (!nf.ok) {
      this.lastError = "NULLIFIER_REPLAY";
      this.emit({ event: "apply_fail", reason: this.lastError });
      return;
    }
    }
    this.appliedHeights.add(env.height);
    if (!this.commitLog.some((c) => c.env.payloadDigest === env.payloadDigest)) {
      this.commitLog.push({ env, votes });
    }
    this.heightLock.tryLock(env.epoch, env.height, env.payloadDigest, this.id);
    this.persistCommit();
    this.mesh.broadcast("P4_COMMIT", Buffer.from(JSON.stringify({ env, votes }), "utf8"));
    if (env.height >= this.tipHeight) {
      this.tipHeight = env.height + 1;
      this.view = 0;
      this.vcVotes = [];
    }
    this.emit({ event: "applied", root: this.state.stateRoot(), height: env.height });
  }

  view = Number(process.env.UEP_P4_VIEW ?? "0");
  tipHeight = 1;
  vcVotes: ViewChangeVote[] = [];

  async ensurePeers(): Promise<string[]> {
    for (const [id, port] of this.dialBook) {
      if (!this.mesh.peerIds().includes(id)) {
        await this.mesh.connectPeer(id, "127.0.0.1", port);
      }
    }
    const have = new Set(this.mesh.peerIds());
    return [...this.dialBook.keys()].filter((id) => !have.has(id));
  }

  async startViewChange(nextView: number): Promise<void> {
    if (nextView <= this.view) {
      this.emit({ event: "reject", reason: "VIEW_NOT_HIGHER", view: this.view });
      return;
    }
    await this.ensurePeers();
    const vote = signViewChangeVote(
      this.identity,
      p4ViewTarget(this.tipHeight, nextView, this.state.stateRoot()),
    );
    this.onViewVote(vote);
    this.mesh.broadcast("P4_VIEW_CHANGE", Buffer.from(JSON.stringify(vote), "utf8"));
  }

  private onViewVote(v: ViewChangeVote): void {
    const nextView = Number(String(v.targetDigest).split("|")[5] ?? this.view + 1);
    const tgt = p4ViewTarget(this.tipHeight, Number.isFinite(nextView) ? nextView : this.view + 1, this.state.stateRoot());
    if (this.vcVotes.some((x) => x.nodeId === v.nodeId && x.targetDigest === v.targetDigest)) return;
    this.vcVotes.push(v);
    this.emit({ event: "view_vote", from: v.nodeId, n: this.vcVotes.length });
    const ids = [...this.pubkeys.keys()];
    const qc = assembleViewChangeQC(tgt, this.vcVotes, ids, (id) => this.pubkeys.get(id));
    if (!qc.ok) return;
    this.view = tgt.nextView;
    this.vcVotes = [];
    this.emit({
      event: "view_adopted",
      view: this.view,
      leader: scheduledLeader(this.tipHeight, ids, this.view),
      height: this.tipHeight,
    });
  }

  async proposeMany(spends: { who: string; amount: bigint }[], height: number): Promise<void> {
    const ids = [...this.pubkeys.keys()];
    const lead = scheduledLeader(height, ids, this.view);
    if (lead !== this.id) {
      this.emit({ event: "reject", reason: "NOT_LEADER", leader: lead, height, view: this.view });
      return;
    }
    const proved = await proveManyParallel(
      this.state,
      spends.map((s) => ({ who: s.who, ids: labParty(s.who), amount: s.amount })),
    );
    if (!proved.ok) throw new Error(proved.reason ?? "BATCH_PROVE_FAIL");
    const payload = {
      batchId: `p4n-${height}`,
      view: this.view,
      txDigest: proved.finalRoot,
      stateRoot: proved.finalRoot,
      epoch: 1,
      height,
      previousStateRoot: this.state.stateRoot(),
      amount: spends.reduce((a, s) => a + s.amount, 0n).toString(),
      zkSpend: serializeStagingArtifact(proved.arts[proved.arts.length - 1]!),
      batch: spends.map((s, i) => ({
        amount: s.amount.toString(),
        who: s.who,
        zkSpend: serializeStagingArtifact(proved.arts[i]!),
      })),
    };
    const env = sealConsensusMsg(this.identity, "PROPOSAL", 1, height, payload);
    this.emit({ event: "proved", wallMs: proved.wallMs, n: spends.length, height });
    await this.ensurePeers();
    this.onProposal(env);
    this.mesh.broadcast("P4_PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
  }

  async proposeBatch(amountA: bigint, amountB: bigint, height: number): Promise<void> {
    await this.proposeMany(
      [
        { who: "alice", amount: amountA },
        { who: "carol", amount: amountB },
      ],
      height,
    );
  }

  async replayLast(height: number): Promise<void> {
    const last = this.commitLog[this.commitLog.length - 1];
    if (!last) {
      this.emit({ event: "reject", reason: "NO_COMMIT" });
      return;
    }
    const prev = JSON.parse(last.env.payload) as P4ProposalExtra;
    const payload: P4ProposalExtra = { ...prev, height, batchId: `replay-${height}`, view: this.view };
    const env = sealConsensusMsg(this.identity, "PROPOSAL", 1, height, payload);
    this.onProposal(env);
    this.mesh.broadcast("P4_PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    this.emit({ event: "replay_sent", height });
  }

  async propose(amount: bigint, height: number): Promise<void> {
    const ids = [...this.pubkeys.keys()];
    const lead = scheduledLeader(height, ids, this.view);
    if (lead !== this.id) {
      this.emit({ event: "reject", reason: "NOT_LEADER", leader: lead, height, view: this.view });
      return;
    }
    const oldRoot = this.state.stateRoot();
    const art = proveWithoutApply(this.state, this.ids, amount);
    if (!art.ok) throw new Error("PROVE_FAIL");
    const payload: P4ProposalExtra = {
      batchId: `p4p-${height}`,
      view: this.view,
      txDigest: art.newRootProof,
      stateRoot: art.newRootProof,
      epoch: 1,
      height,
      previousStateRoot: oldRoot,
      amount: amount.toString(),
      zkSpend: serializeStagingArtifact(art),
      spendId: canonicalSpendId(LAB_PROFILE.domainId, "alice", art.publicInputsHex[10] ?? art.newRootProof),
      senderAuth: signSenderAuth(this.ids.senderSecret, labAuthBodyFromArtifact(art)),
    };
    const env = sealConsensusMsg(this.identity, "PROPOSAL", 1, height, payload);
    await this.ensurePeers();
    this.onProposal(env);
    const missed = this.mesh.broadcast("P4_PROPOSAL", Buffer.from(JSON.stringify(env), "utf8"));
    if (missed.length) this.emit({ event: "broadcast_miss", kind: "P4_PROPOSAL", missed });
  }
}

async function main(): Promise<void> {
  const nodeId = process.env.UEP_P4_NODE_ID ?? "";
  const bootPath = process.env.UEP_P4_BOOTSTRAP ?? "";
  const depth = Number(process.env.UEP_P4_DEPTH ?? "4") === 32 ? 32 : 4;
  const boot = JSON.parse(readFileSync(bootPath, "utf8")) as P4Bootstrap;
  const dataDir = process.env.UEP_P4_DATA_DIR ?? "";
  const rt = new P4ProcessRuntime(boot, nodeId, depth, dataDir || undefined);
  const fromDisk = rt.loadCommitFromDisk();
  const port = await rt.mesh.listen("127.0.0.1", 0);
  rt.emit({ event: "ready", id: nodeId, port, version: P4_PROCESS_VERSION, fromDisk });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      const op = String(cmd.op ?? "");
      if (op === "connect") {
        const peerId = String(cmd.peerId);
        const port = Number(cmd.port);
        rt.dialBook.set(peerId, port);
        const ok = await rt.mesh.connectPeer(peerId, "127.0.0.1", port);
        if (ok && rt.mesh.peerIds().includes(peerId)) {
          rt.emit({ event: "connected", peerId });
        } else {
          rt.emit({ event: "connect_fail", peerId });
        }
      } else if (op === "viewchange") {
        await rt.startViewChange(Number(cmd.nextView ?? rt.view + 1));
      } else if (op === "propose-batch") {
        await rt.proposeBatch(BigInt(String(cmd.amountA)), BigInt(String(cmd.amountB)), Number(cmd.height ?? rt.tipHeight));
      } else if (op === "propose-many") {
        const spends = (cmd.spends as { who: string; amount: string }[]).map((s) => ({ who: s.who, amount: BigInt(s.amount) }));
        await rt.proposeMany(spends, Number(cmd.height ?? rt.tipHeight));
      } else if (op === "propose") {
        await rt.propose(BigInt(String(cmd.amount)), Number(cmd.height ?? rt.tipHeight));
      } else if (op === "replay-nullifier") {
        await rt.replayLast(Number(cmd.height ?? rt.tipHeight));
      } else if (op === "catchup") {
        rt.mesh.broadcast("P4_CATCHUP_REQ", Buffer.from("{}", "utf8"));
        rt.emit({ event: "catchup_sent" });
      } else if (op === "flushcommits") {
        for (const cmt of rt.commitLog) {
          rt.mesh.broadcast("P4_COMMIT", Buffer.from(JSON.stringify(cmt), "utf8"));
        }
        rt.emit({ event: "flush_sent", n: rt.commitLog.length });
      } else if (op === "status") {
        rt.emit({
          event: "status",
          root: rt.state.stateRoot(),
          applied: rt.appliedHeights.size > 0,
          heights: [...rt.appliedHeights],
          view: rt.view,
          leader: scheduledLeader(rt.tipHeight, [...rt.pubkeys.keys()], rt.view),
          tipHeight: rt.tipHeight,
          votes: [...rt.votesByDigest.values()].reduce((n, l) => n + l.length, 0),
          error: rt.lastError,
        });
      }
    } catch (e) {
      rt.emit({ event: "error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}

if (process.env.UEP_P4_PROCESS === "1") {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ event: "fatal", error: String(e) }) + "\n");
    process.exit(1);
  });
}
