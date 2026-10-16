/**
 * 0.5.84 item 1: unified durable state store (journal + BFT state + economic head in one WAL).
 * Single-machine evidence: atomic frames, torn-tail repair, idempotent recovery, interrupted
 * compaction, migration from the 0.5.83 files, crash injection at every write point of the
 * certified commit, and real SIGKILL (kill -9) of a writer process. It says nothing about a
 * distributed network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { assembleNode } from "./assemble.ts";
import { BftConsensusKernel, type BftCertificate, type BftProposal } from "./bft-consensus.ts";
import { BftDurableStateStore } from "./bft-durable-store.ts";
import { CertifiedCommitter, CommitLog, type CommitWritePoint } from "./certified-commit.ts";
import { UNIFIED_CHECKPOINT_FILE, UNIFIED_WAL_FILE, UnifiedStateStore, type StoreWritePoint } from "./unified-state-store.ts";
import { LEGACY_BFT_KERNEL_FILE, LEGACY_COMMIT_LOG_FILE, openUnifiedValidatorState, storeContext } from "./unified-node-state.ts";

const ASSET = "uep-test/teur";
const ROOT = new URL("../..", import.meta.url).pathname;
type Step = { tx: UepTransaction; proposal: BftProposal; proposalSignature: string; certificate: BftCertificate; preRoot: string; postRoot: string };

async function world(n = 3) {
  const snapshotKey = generateEd25519KeyPair(), faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 31n });
  seed.ledger.faucet(buyer.accountId, ASSET, 50_050n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const fresh = () => UepLedger.restore(genesis, trust, { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey });
  const vkeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators = vkeys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  const ref = fresh();
  const domain = { networkId: ref.networkId, domainId: ref.domainId };
  const builder = new BftConsensusKernel(domain, validators, 1);
  const certify = (p: BftProposal) => {
    const lead = vkeys[Number(p.proposerId.slice(1))]!;
    const sig = builder.signProposal(p, lead.privateKey);
    const prevotes = [0, 1, 2].map(i => builder.createVote(p, "prevote", `v${i}`, vkeys[i]!.privateKey, sig));
    const pc = builder.voteCertificate(p.height, p.round, "prevote", p.blockId, prevotes);
    builder.observePrevoteCertificate(pc);
    const locked = { ...p, prevoteCertificate: pc };
    const lsig = builder.signProposal(locked, lead.privateKey);
    const pre = [0, 1, 2].map(i => builder.createVote(locked, "precommit", `v${i}`, vkeys[i]!.privateKey, lsig));
    return { proposal: locked, proposalSignature: lsig, certificate: builder.voteCertificate(p.height, p.round, "precommit", p.blockId, pre) };
  };
  const steps: Step[] = [];
  const base = ref.height;
  for (let i = 0; i < n; i++) {
    const built = ref.preparePayment(buyer, custody.accountId, ASSET, 100n + BigInt(i), ref.height, { outputBlinding: clientBlinding(100n + BigInt(2 * i)), changeBlinding: clientBlinding(101n + BigInt(2 * i)) });
    if ("error" in built) throw new Error(built.error.code);
    const tx = built.txs[0]!;
    const preRoot = ref.stateRoot().toHex();
    const height = base + 1 + i;
    const p: BftProposal = { ...domain, height, round: 0, proposerId: builder.leader(height, 0), parentRoot: preRoot, blockId: tx.txId.toHex() };
    const c = certify(p);
    const r = ref.submit(tx); if ("error" in r) throw new Error(r.error.code);
    steps.push({ tx, ...c, preRoot, postRoot: ref.stateRoot().toHex() });
  }
  return { fresh, domain, validators, steps };
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uep-unified-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const CTX = { networkId: "uep-test", domainId: "d", validatorSetHash: "ab".repeat(32) };
const input = (s: Step) => ({ proposal: s.proposal, proposalSignature: s.proposalSignature, certificate: s.certificate, tx: s.tx });

test("unified store: frames are durable, chained and reopen to the same view", () => {
  const dir = tmp();
  const s = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0 });
  for (let i = 1; i <= 5; i++) s.append([{ kind: "economic", head: { height: i, stateRoot: String(i).padStart(64, "0"), txCount: i } }]);
  const again = UnifiedStateStore.open(dir, CTX);
  assert.equal(again.frameSeq, 5);
  assert.equal(again.headHash, s.headHash);
  assert.deepEqual(again.economicHead, s.economicHead);
  assert.throws(() => UnifiedStateStore.open(dir, { ...CTX, domainId: "other" }), /UNIFIED_STORE_CONTEXT_MISMATCH/);
});

test("unified store: a torn last frame is truncated at every byte offset; recovery twice gives the same view", () => {
  const dir = tmp();
  const s = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0 });
  s.append([{ kind: "economic", head: { height: 1, stateRoot: "1".padStart(64, "0"), txCount: 1 } }]);
  const good = statSync(join(dir, UNIFIED_WAL_FILE)).size;
  s.append([{ kind: "economic", head: { height: 2, stateRoot: "2".padStart(64, "0"), txCount: 2 } }, { kind: "bft", state: { version: 3, votes: [], committed: [], locks: [], roundChanges: [] } as never }]);
  const full = readFileSync(join(dir, UNIFIED_WAL_FILE));
  for (let cut = good + 1; cut < full.length; cut++) {
    writeFileSync(join(dir, UNIFIED_WAL_FILE), full.subarray(0, cut));
    const r = UnifiedStateStore.open(dir, CTX);
    assert.equal(r.frameSeq, 1, `cut ${cut}`);
    assert.equal(r.economicHead?.height, 1);
    assert.equal(r.bftState, null, "no half frame is visible");
    const r2 = UnifiedStateStore.open(dir, CTX);
    assert.equal(r2.headHash, r.headHash);
    assert.equal(r2.repairedTornBytes, 0);
  }
  // Complete length, damaged content in the LAST frame: torn, truncated.
  const damaged = Buffer.from(full); damaged[damaged.length - 3] ^= 0xff;
  writeFileSync(join(dir, UNIFIED_WAL_FILE), damaged);
  assert.equal(UnifiedStateStore.open(dir, CTX).frameSeq, 1);
});

test("unified store: a damaged frame that is not the last one is corruption (no silent repair)", () => {
  const dir = tmp();
  const s = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0 });
  for (let i = 1; i <= 3; i++) s.append([{ kind: "economic", head: { height: i, stateRoot: String(i).padStart(64, "0"), txCount: i } }]);
  const wal = readFileSync(join(dir, UNIFIED_WAL_FILE));
  const firstFrame = wal.indexOf("UEPW");
  wal[firstFrame + 60] ^= 0x01;
  writeFileSync(join(dir, UNIFIED_WAL_FILE), wal);
  assert.throws(() => UnifiedStateStore.open(dir, CTX), /UNIFIED_STORE_CORRUPT/);
});

for (const point of ["checkpoint-written", "wal-reset"] as StoreWritePoint[]) {
  test(`unified store: compaction interrupted at ${point} reopens to the same view and keeps appending`, () => {
    const dir = tmp();
    let armed = false;
    const s = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0, faultInjector: (p) => { if (armed && p === point) throw new Error("CRASH"); } });
    for (let i = 1; i <= 4; i++) s.append([{ kind: "economic", head: { height: i, stateRoot: String(i).padStart(64, "0"), txCount: i } }]);
    const head = s.headHash;
    armed = true;
    assert.throws(() => s.compact(), /CRASH/);
    assert.ok(existsSync(join(dir, UNIFIED_CHECKPOINT_FILE)));
    const r = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0 });
    assert.equal(r.frameSeq, 4); assert.equal(r.headHash, head); assert.equal(r.economicHead?.height, 4);
    r.append([{ kind: "economic", head: { height: 5, stateRoot: "5".padStart(64, "0"), txCount: 5 } }]);
    const r2 = UnifiedStateStore.open(dir, CTX);
    assert.equal(r2.frameSeq, 5); assert.equal(r2.economicHead?.height, 5);
  });
}

test("unified store: real SIGKILL of a writer process at random moments (with auto-compaction) never leaves a half frame", { timeout: 180_000 }, async () => {
  const dir = tmp();
  const results: number[] = [];
  for (let round = 0; round < 12; round++) {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "src/node/unified-store-writer.fixture.ts"), dir, "7"], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("exit", (code) => reject(new Error(`writer exited early ${code}: ${err}`)));
    });
    await new Promise(r => setTimeout(r, 20 + ((round * 37) % 90)));
    child.kill("SIGKILL");
    await new Promise(r => child.once("exit", r));
    const s = UnifiedStateStore.open(dir, CTX, { autoCompactFrames: 0 });
    const h = s.economicHead?.height ?? 0;
    // All-or-nothing: the bft marker written in the same frame always matches the economic head.
    assert.deepEqual(s.bftState ? (s.bftState as unknown as { committed: [string, string][] }).committed : [], h ? [[String(h), String(h).padStart(64, "0")]] : []);
    assert.equal(s.frameSeq, h, "one frame per height, no gap");
    if (results.length) assert.ok(h >= results.at(-1)!, "never goes backwards");
    results.push(h);
  }
  assert.ok(results.at(-1)! > 0);
  console.log(`[unified-store sigkill] heights after each kill: ${results.join(",")}`);
});

test("unified store: migration from 0.5.83 files (commit log + kernel state) is one frame and idempotent", async () => {
  const w = await world(2);
  const dir = tmp();
  const ledger = w.fresh();
  const legacyKernel = new BftConsensusKernel(w.domain, w.validators, 1, st => new BftDurableStateStore(join(dir, LEGACY_BFT_KERNEL_FILE), w.domain, w.validators).save(st));
  const legacy = new CertifiedCommitter(new CommitLog(join(dir, LEGACY_COMMIT_LOG_FILE)), legacyKernel, () => ledger);
  legacy.applyCertifiedCommit(input(w.steps[0]!));
  const legacyHead = legacy.log.headHash;
  const u = openUnifiedValidatorState(dir, w.domain, w.validators, 1);
  assert.equal(u.migration.migrated, true);
  assert.equal(u.migration.commits, 2);
  assert.equal(u.migration.bftState, true);
  assert.equal(u.log.headHash, legacyHead);
  assert.ok(existsSync(join(dir, LEGACY_COMMIT_LOG_FILE + ".migrated")));
  assert.ok(!existsSync(join(dir, LEGACY_COMMIT_LOG_FILE)));
  // Crash after the frame but before the rename: put a legacy file back, reopen; no second copy.
  writeFileSync(join(dir, LEGACY_COMMIT_LOG_FILE), readFileSync(join(dir, LEGACY_COMMIT_LOG_FILE + ".migrated")));
  const u2 = openUnifiedValidatorState(dir, w.domain, w.validators, 1);
  assert.equal(u2.migration.migrated, false);
  assert.equal(u2.log.all().length, 2);
  // The migrated journal continues: the next height commits through the unified log.
  const ledger2 = w.fresh();
  const c = new CertifiedCommitter(u2.log, u2.kernel, () => ledger2, { requireDurable: true });
  c.recover();
  assert.equal(ledger2.stateRoot().toHex(), w.steps[0]!.postRoot);
  const r = c.applyCertifiedCommit(input(w.steps[1]!));
  assert.equal(r.durable, true);
  assert.equal(u2.store.economicHead?.stateRoot, w.steps[1]!.postRoot);
});

test("finality only after a durable commit: an in-memory log is refused when durability is required", async () => {
  const w = await world(1);
  const ledger = w.fresh();
  assert.throws(() => new CertifiedCommitter(new CommitLog(null), new BftConsensusKernel(w.domain, w.validators, 1), () => ledger, { requireDurable: true }), /BFT_COMMIT_LOG_NOT_DURABLE/);
  const inMem = new CertifiedCommitter(new CommitLog(null), new BftConsensusKernel(w.domain, w.validators, 1), () => ledger);
  assert.equal(inMem.applyCertifiedCommit(input(w.steps[0]!)).durable, undefined, "never marked durable");
});

const COMMIT_POINTS: CommitWritePoint[] = ["before-intent", "intent-torn", "after-intent", "after-apply", "applied-torn", "after-applied", "after-kernel-commit"];
for (const point of COMMIT_POINTS) {
  test(`unified store: crash at ${point} then recovery (twice) gives one APPLIED height, matching economic head and state root`, async () => {
    const w = await world(2);
    const dir = tmp();
    let armed = true;
    const u = openUnifiedValidatorState(dir, w.domain, w.validators, 1, {}, {}, { init: "genesis" });
    const ledger = w.fresh();
    const c = new CertifiedCommitter(u.log, u.kernel, () => ledger, { requireDurable: true, faultInjector: (p) => { if (armed && p === point) throw new Error("CRASH_INJECTED"); } });
    assert.throws(() => c.applyCertifiedCommit(input(w.steps[0]!)), /CRASH_INJECTED/);
    armed = false;
    const views: string[] = [];
    for (let i = 0; i < 2; i++) {
      // Restart: memory is gone; the ledger starts from genesis and is rebuilt from the store.
      const r = openUnifiedValidatorState(dir, w.domain, w.validators, 1);
      const l = w.fresh();
      const rc = new CertifiedCommitter(r.log, r.kernel, () => l, { requireDurable: true });
      rc.recover();
      const h = w.steps[0]!.proposal.height;
      if (point === "before-intent" || point === "intent-torn") {
        // Nothing durable for h (a torn INTENT frame is dropped); the certificate is final elsewhere.
        if (i === 0) assert.equal(rc.status(h), "UNKNOWN");
        if (rc.status(h) === "UNKNOWN") rc.applyCertifiedCommit(input(w.steps[0]!)); // the certificate is final elsewhere; the node catches up
      }
      assert.equal(rc.status(h), "APPLIED", point);
      assert.equal(l.stateRoot().toHex(), w.steps[0]!.postRoot);
      assert.equal(l.txs.filter(t => t.txId.toHex() === w.steps[0]!.tx.txId.toHex()).length, 1, "applied once");
      const reopened = UnifiedStateStore.open(dir, storeContext(w.domain, w.validators));
      assert.equal(reopened.economicHead?.stateRoot, w.steps[0]!.postRoot, "economic head written with APPLIED");
      assert.ok(r.kernel.exportState().committed.some(([x]) => x === String(h)), "kernel commit restored");
      views.push(JSON.stringify({ head: reopened.headHash === undefined ? null : rc.log.headHash, entries: rc.log.all().length, root: l.stateRoot().toHex() }));
    }
    assert.equal(views[0], views[1], "recovery is idempotent");
  });
}
