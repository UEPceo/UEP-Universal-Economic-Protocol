/**
 * One BFT validator in its own OS process (item 3 harness, 0.5.81). Experimental.
 *
 * Own keys, own state directory (durable kernel store + certified commit log), PeerNet for
 * validator traffic, and a separate control port on 127.0.0.1 used only by the test harness
 * to ask this validator to propose, sync, report its state, or (when configured byzantine)
 * send conflicting proposals. The control port is not part of the protocol.
 *
 *   node --experimental-strip-types src/node/bft-validator-process.ts <config.json>
 */
import { createServer } from "node:http";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signEd25519 } from "../core/ed25519.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { createDurableBftConsensusKernel } from "./bft-durable-store.ts";
import { openUnifiedValidatorState } from "./unified-node-state.ts";
import type { CommitLog as CommitLogT } from "./certified-commit.ts";
import type { BftProposal, BftValidator } from "./bft-consensus.ts";
import { txFromWire, txToWire } from "./certified-commit.ts";
import { PeerNet, type Peer } from "./peer-net.ts";
import { attestationRegistryPath, continuityFromEnv, PENDING_PEER_CHECK, type ContinuityOptions } from "./bft-store-continuity.ts";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

type Config = {
  id: string; voterPem: string; stateDir: string; peerPort: number; controlPort: number;
  validators: BftValidator[]; faultTolerance: number; peers: Peer[];
  genesisFile: string; trust: { authorities: string[]; faucetPublicKeys: string[] };
  /** 0.5.83 Block B: when set, an internal height-producer ticker feeds the round timer every autoTickMs (ticks are counted heights, not wall time inside the protocol). */
  autoTickMs?: number;
  roundTimer?: { baseTicks: number; maxDoublings: number };
  /** Per-IP peer rate limit; the loopback harness raises it because all peers share 127.0.0.1. */
  peerRateMax?: number;
};

const decode = (_k: string, v: unknown) => v && typeof v === "object" && "$b" in v && typeof (v as { $b: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;
const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Config;
const key = createPrivateKey(cfg.voterPem);
const me = cfg.validators.find(v => v.id === cfg.id)!;
const genesis = JSON.parse(readFileSync(cfg.genesisFile, "utf8"), decode);
const ledger = UepLedger.restore(genesis, cfg.trust);
const voters = new Map(cfg.validators.map(v => [v.id, v.publicKeyHex]));
const net = new PeerNet(cfg.id, ledger, key, me.publicKeyHex, cfg.peers, voters, 2, cfg.stateDir);
const domain = { networkId: ledger.networkId, domainId: ledger.domainId };
// 0.5.84 item 1: the unified store (one WAL for journal + BFT state + economic head) is the default;
// UEP_STATE_BACKEND=legacy keeps the 0.5.83 files (bft-kernel.json + bft-commit-log.jsonl).
const backend = process.env.UEP_STATE_BACKEND === "legacy" ? "legacy" : "unified";
let unifiedLog: CommitLogT | undefined;
let unifiedStore: import("./unified-state-store.ts").UnifiedStateStore | undefined;
let kernel: import("./bft-consensus.ts").BftConsensusKernel;
// 0.5.84 store continuity: refuse to start without the store unless UEP_BFT_STORE_INIT=genesis (first start
// of a new identity) or UEP_BFT_REJOIN=retire (re-key/rejoin: this identity becomes watch-only for good).
// UEP_TEST_BYZANTINE_STATELESS=1 is a TEST-HARNESS-ONLY switch that models a Byzantine validator which
// ignores its own store (it signs from whatever state it has); an honest binary never sets it.
const byzantineStateless = process.env.UEP_TEST_BYZANTINE_STATELESS === "1";
const continuity: ContinuityOptions = byzantineStateless
  ? { init: "genesis", anchorPath: join(tmpdir(), `uep-byz-anchor-${randomBytes(6).toString("hex")}.json`), validatorId: cfg.id }
  : { ...continuityFromEnv(), validatorId: cfg.id };
let continuityState: import("./unified-node-state.ts").ContinuityState | undefined;
if (backend === "unified") {
  const crash = process.env.UEP_CRASH_AT?.match(/^(frame-torn|checkpoint-written|wal-reset)@(\d+)$/);
  const u = openUnifiedValidatorState(cfg.stateDir, domain, cfg.validators, cfg.faultTolerance, {}, crash ? {
    faultInjector: (p) => { if (p === crash[1] && net.bftOpenHeight() === Number(crash[2])) { if (p === "frame-torn") throw new Error("CRASH_TORN"); process.kill(process.pid, "SIGKILL"); } },
    afterTornWrite: () => process.kill(process.pid, "SIGKILL"),
  } : {}, continuity);
  kernel = u.kernel; unifiedLog = u.log; unifiedStore = u.store; continuityState = u.continuity;
  if (u.migration.migrated) console.log(`[unified-store] ${cfg.id} migrated ${u.migration.commits} journal entries, bftState=${u.migration.bftState}`);
} else {
  kernel = createDurableBftConsensusKernel(domain, cfg.validators, cfg.faultTolerance, join(cfg.stateDir, "bft-kernel.json"), {}, continuity);
}
net.configureBftConsensus(kernel, { log: unifiedLog, requireDurable: true });
// 0.5.84 store continuity (C): attest the store position to peers after each durable frame, and do not
// sign until 2f peers have answered the "what is my latest attested state?" check.
let peerCheck: { responses: number; stale: boolean; maxSeen: number; done: boolean } = { responses: 0, stale: false, maxSeen: 0, done: false };
if (continuityState) {
  net.configureStateAttestation(attestationRegistryPath(cfg.stateDir));
  const cs = continuityState;
  cs.onDurable.add(p => net.attestState(p));
  if (cs.verdict === "ok" && !byzantineStateless) {
    kernel.suspendSigning(PENDING_PEER_CHECK);
    const need = 2 * cfg.faultTolerance;
    const check = async (): Promise<void> => {
      const local = cs.position();
      const r = await net.bftCheckStateAgainstPeers(local).catch(() => ({ responses: 0, stale: false, maxSeen: 0 }));
      peerCheck = { ...r, done: false };
      if (r.stale) {
        peerCheck.done = true;
        kernel.suspendSigning("BFT_STORE_STALE");
        console.error(`[store-continuity] ${cfg.id} BFT_STORE_STALE: peers attest stateSeq ${r.maxSeen} > local ${local.seq}; signing stays suspended, rejoin with a new identity (UEP_BFT_REJOIN=retire)`);
        return;
      }
      if (r.responses >= need) {
        peerCheck.done = true;
        kernel.resumeSigning();
        net.attestState(local);
        console.log(`[store-continuity] ${cfg.id} peer check passed (${r.responses} answers, local seq ${local.seq})`);
        return;
      }
      setTimeout(() => { void check(); }, 300).unref();
    };
    setTimeout(() => { void check(); }, 50).unref();
  }
}
// 0.5.83 Block C: crash injection (test harness only). UEP_CRASH_AT="<write point>@<height>" kills this
// process with SIGKILL (kill -9) at that write point of that BFT height: no cleanup, no flush.
const crashAt = process.env.UEP_CRASH_AT?.match(/^([a-z-]+)@(\d+)$/);
if (crashAt) {
  const [, point, h] = crashAt;
  const committer = () => (net as unknown as { committer: { log: { all(): readonly { height: number }[] } } }).committer;
  // Height of the commit in progress: the open height before the INTENT exists, else the last log entry's height.
  const isTarget = (p: string) => (p === "before-intent" || p === "intent-torn" ? net.bftOpenHeight() : committer().log.all().at(-1)?.height) === Number(h);
  const die = () => { process.kill(process.pid, "SIGKILL"); };
  net.commitFaultInjector = (p) => {
    if (p !== point || !isTarget(p)) return;
    if (p.endsWith("-torn")) throw new Error("CRASH_TORN"); // write half a line, then afterTornWrite kills
    die();
  };
  net.commitAfterTornWrite = () => { if (point!.endsWith("-torn")) die(); };
}
const recovered = await net.recoverBftCommits();
if (cfg.roundTimer) net.configureRoundTimer(cfg.roundTimer);
if (cfg.peerRateMax) net.rateMax = cfg.peerRateMax;

// 0.5.83 Block B: pending transactions (harness-submitted) and automatic round change / re-proposal.
const mempool = new Map<string, ReturnType<typeof txFromWire>>();
const proposedAt = new Set<string>();
const chosen = new Map<string, string>();
const lastTryTick = new Map<string, number>();
let tick = 0;
let ticking = false;
async function autoStep(): Promise<void> {
  if (ticking) return; ticking = true;
  try {
    tick += 1;
    await net.bftTick(tick);
    const height = net.bftOpenHeight();
    for (const [id, tx] of mempool) if (net.ledger.txs.some(t => t.txId.toHex() === id)) mempool.delete(id);
    const round = net.bftRound();
    if (round < 1 || net.bftLeader(height, round) !== cfg.id || proposedAt.has(`${height}:${round}`)) return;
    // Back off between re-proposals of one round (every baseTicks ticks), to keep peer traffic bounded.
    const lastTry = lastTryTick.get(`${height}:${round}`);
    if (lastTry !== undefined && tick - lastTry < (cfg.roundTimer?.baseTicks ?? 4)) return;
    lastTryTick.set(`${height}:${round}`, tick);
    if (!net.bftRoundChangeCertificate(height, round)) return;
    proposedAt.add(`${height}:${round}`);
    // Prefer the block a round-change certificate forces (highest lock), else any pending transaction that applies.
    const rc = net.bftRoundChangeCertificate(height, round)!;
    const required = kernel.requiredProposalFromRoundChanges(rc);
    const chosenId = chosen.get(`${height}:${round}`);
    const candidates = chosenId ? [net.bftTransaction(chosenId) ?? mempool.get(chosenId)].filter(Boolean)
      : required ? [net.bftTransaction(required.blockId) ?? mempool.get(required.blockId)].filter(Boolean) : [...mempool.values()];
    for (const tx of candidates) {
      chosen.set(`${height}:${round}`, tx!.txId.toHex());
      try { await net.bftProposeAfterRoundChange(tx!); console.log(`[auto] ${cfg.id} proposed height=${height} round=${round}`); return; } catch (e) { const msg = (e as Error).message; console.error(`[auto] ${cfg.id} propose failed: ${msg}`); if (msg !== "BFT_QUORUM_NOT_MET" && msg !== "BFT_ALREADY_PROPOSED_OTHER_BLOCK") { chosen.delete(`${height}:${round}`); continue; } break; }
    }
    // No quorum yet (drops, partition): retry the same proposal on a later tick of this round.
    // Re-sending the identical signed proposal is idempotent for honest voters (same proposal core).
    proposedAt.delete(`${height}:${round}`);
  } catch (e) {
    console.error(`[auto] ${cfg.id} tick failed: ${(e as Error).message}`);
  } finally { ticking = false; }
}
if (cfg.autoTickMs) setInterval(() => { void autoStep(); }, cfg.autoTickMs).unref();
await net.listen(cfg.peerPort);

const reply = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body, encode));
};
const readBody = (req: import("node:http").IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let s = ""; req.on("data", c => { s += c; }); req.on("end", () => resolve(s ? JSON.parse(s, decode) : {}));
});

const state = () => ({
  id: cfg.id, stateRoot: net.ledger.stateRoot().toHex(), txCount: net.ledger.txs.length,
  committed: kernel.exportState().committed,
  status: Object.fromEntries(kernel.exportState().committed.map(([h]) => [h, net.bftCommitStatus(Number(h))])),
  expectedHeight: (net as unknown as { committer: { expectedHeight(): number } }).committer.expectedHeight(),
  signing: kernel.signingSuspended ?? "ok",
  storeSeq: continuityState?.position().seq ?? null,
  peerCheck,
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    const body = req.method === "POST" ? await readBody(req) : {};
    if (url.pathname === "/ctl/state") return reply(res, 200, state());
    if (url.pathname === "/ctl/sync") return reply(res, 200, { applied: await net.bftSync(), ...state() });
    if (url.pathname === "/ctl/propose") {
      const tx = txFromWire(body.tx as never);
      const height = state().expectedHeight;
      const round = Number(body.round ?? 0);
      const proposal: BftProposal = { ...domain, height, round, proposerId: cfg.id, parentRoot: net.ledger.stateRoot().toHex(), blockId: tx.txId.toHex() };
      const cert = await net.bftPropose(proposal, tx);
      return reply(res, 200, { height, blockId: cert.blockId, votes: cert.votes.length });
    }
    if (url.pathname === "/ctl/audit") {
      // 0.5.83 Block C: re-open the commit log from disk (hash chain verified by CommitLog), then check
      // height continuity, that the ledger applied exactly the APPLIED blocks in order, and the state root.
      const { CommitLog } = await import("./certified-commit.ts");
      let log: CommitLogT;
      if (unifiedStore) {
        const { UnifiedStateStore } = await import("./unified-state-store.ts");
        log = CommitLog.unified(UnifiedStateStore.open(cfg.stateDir, unifiedStore.context)); // re-read from disk: checksums + hash chains
      } else log = new CommitLog(join(cfg.stateDir, "bft-commit-log.jsonl"));
      const entries = log.all();
      const decided = entries.filter(e => e.type !== "INTENT");
      const problems: string[] = [];
      for (let i = 1; i < decided.length; i++) if (decided[i]!.height !== decided[i - 1]!.height + 1) problems.push(`height gap ${decided[i - 1]!.height}->${decided[i]!.height}`);
      const applied = entries.filter(e => e.type === "APPLIED");
      const ledgerTxs = net.ledger.txs.map(t => t.txId.toHex());
      const tail = ledgerTxs.slice(ledgerTxs.length - applied.length);
      if (JSON.stringify(tail) !== JSON.stringify(applied.map(e => e.blockId))) problems.push("ledger txs differ from APPLIED blocks");
      for (let i = 1; i < applied.length; i++) if (applied[i]!.preRoot !== applied[i - 1]!.postRoot) problems.push(`root chain broken at ${applied[i]!.height}`);
      const lastRoot = applied.at(-1)?.postRoot ?? null;
      if (lastRoot && lastRoot !== net.ledger.stateRoot().toHex()) problems.push("state root differs from last APPLIED post-root");
      if (net.bftCommitStatus(net.bftOpenHeight() - 1) === "CERTIFIED_NOT_APPLIED") problems.push("certified height left unapplied");
      if (unifiedStore) {
        // The economic head written in the same frame as the last APPLIED entry must match it.
        const { UnifiedStateStore } = await import("./unified-state-store.ts");
        const head = UnifiedStateStore.open(cfg.stateDir, unifiedStore.context).economicHead;
        if (lastRoot && head && head.stateRoot !== lastRoot) problems.push("economic head differs from last APPLIED post-root");
      }
      return reply(res, 200, { ok: problems.length === 0, problems, head: log.headHash, entries: entries.length, repairedTornBytes: (net as unknown as { committer: { log: { repairedTornBytes: number } } }).committer.log.repairedTornBytes, pending: (net as unknown as { committer: { pending(): number[] } }).committer.pending(), recoveredAtStart: recovered, backend, ...state() });
    }
    if (url.pathname === "/ctl/submit") {
      const tx = txFromWire(body.tx as never);
      mempool.set(tx.txId.toHex(), tx);
      return reply(res, 200, { pending: mempool.size });
    }
    if (url.pathname === "/ctl/checkpoint") {
      // 0.5.84 item 2: build a certified checkpoint for this validator's head (needs 2f + 1 signatures).
      const cp = await net.bftCertifyCheckpoint();
      return reply(res, 200, { checkpoint: cp });
    }
    if (url.pathname === "/ctl/checkpoint-fetch") {
      const cp = await net.bftFetchCheckpoint();
      if (cp) net.acceptCheckpoint(cp);
      return reply(res, 200, { checkpoint: net.latestCheckpoint });
    }
    if (url.pathname === "/ctl/checkpoint-accept") {
      net.acceptCheckpoint(body.checkpoint as never);
      return reply(res, 200, { checkpoint: net.latestCheckpoint });
    }
    if (url.pathname === "/ctl/evidence") return reply(res, 200, { evidence: net.bftEquivocationEvidence(), round: net.bftRound(), openHeight: net.bftOpenHeight() });
    if (url.pathname === "/ctl/tick") { await autoStep(); return reply(res, 200, { tick, round: net.bftRound() }); }
    if (url.pathname === "/ctl/equivocate") {
      // Byzantine behaviour: two signed proposals for the same height/round with different blocks,
      // each sent to a different half of the peers. Honest validators must never certify both.
      const txs = (body.txs as never[]).map(w => txFromWire(w));
      const height = state().expectedHeight;
      const parentRoot = net.ledger.stateRoot().toHex();
      const out: unknown[] = [];
      for (const [i, peer] of cfg.peers.entries()) {
        const tx = txs[i % 2]!;
        const proposal: BftProposal = { ...domain, height, round: Number(body.round ?? 0), proposerId: cfg.id, parentRoot, blockId: tx.txId.toHex() };
        const payload = { proposal, proposalSignature: kernel.signProposal(proposal, key), tx: txToWire(tx) };
        const signature = signEd25519(`uep-peer:${cfg.id}:/bft/proposal:${JSON.stringify(payload)}`, key);
        const r = await fetch(peer.url + "/bft/proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: cfg.id, payload, signature }, encode) }).then(x => x.json()).catch(() => null);
        out.push({ peer: peer.id, block: proposal.blockId, vote: !!(r as { vote?: unknown } | null)?.vote });
      }
      return reply(res, 200, { height, out });
    }
    return reply(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    return reply(res, 409, { error: (error as Error).message });
  }
}).listen(cfg.controlPort, "127.0.0.1", () => console.log(`uep-bft-validator ${cfg.id} peer=${cfg.peerPort} control=${cfg.controlPort}`));
