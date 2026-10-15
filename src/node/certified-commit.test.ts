/**
 * H1 (0.5.81): applyCertifiedCommit, durable commit log, crash injection at every write point.
 * Single-process evidence: it shows the transition is atomic and recoverable on one node;
 * it says nothing about a distributed network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { assembleNode } from "./assemble.ts";
import { BftConsensusKernel, type BftCertificate, type BftProposal } from "./bft-consensus.ts";
import { CertifiedCommitter, CommitLog, migrateJournalV1, txToWire, type CommitWritePoint } from "./certified-commit.ts";

const ASSET = "uep-test/teur";

type Step = { tx: UepTransaction; proposal: BftProposal; proposalSignature: string; certificate: BftCertificate; preRoot: string; postRoot: string };

async function world(n = 4) {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 31n });
  seed.ledger.faucet(buyer.accountId, ASSET, 50_050n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const fresh = () => UepLedger.restore(genesis, trust, keys);
  const vkeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators = vkeys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  const ref = fresh();
  const domain = { networkId: ref.networkId, domainId: ref.domainId };
  const builder = new BftConsensusKernel(domain, validators, 1);
  const kernel = () => new BftConsensusKernel(domain, validators, 1);
  const base = ref.height;
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
  return { fresh, kernel, steps };
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uep-h1-")); dirs.push(d); return join(d, "bft-commit-log.jsonl"); };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const input = (s: Step) => ({ proposal: s.proposal, proposalSignature: s.proposalSignature, certificate: s.certificate, tx: s.tx });
const count = (l: UepLedger, s: Step) => l.txs.filter(t => t.txId.toHex() === s.tx.txId.toHex()).length;

test("H1: applyCertifiedCommit applies once and records INTENT then APPLIED in a hash-chained log", async () => {
  const w = await world(2);
  const ledger = w.fresh();
  const path = tmp();
  const k = w.kernel();
  const c = new CertifiedCommitter(new CommitLog(path), k, () => ledger);
  const r = c.applyCertifiedCommit(input(w.steps[0]!));
  assert.equal(r.status, "APPLIED");
  assert.equal(r.postRoot, w.steps[0]!.postRoot);
  assert.equal(ledger.stateRoot().toHex(), w.steps[0]!.postRoot);
  assert.deepEqual(c.log.all().map(e => e.type), ["INTENT", "APPLIED"]);
  assert.equal(c.status(w.steps[0]!.proposal.height), "APPLIED");
  assert.ok(k.exportState().committed.some(([h]) => h === String(w.steps[0]!.proposal.height)));
  assert.equal(new CommitLog(path).headHash, c.log.headHash);
});

test("H1 replay: the same certificate returns the identical stored result and never changes balances twice", async () => {
  const w = await world(1);
  const ledger = w.fresh();
  const c = new CertifiedCommitter(new CommitLog(tmp()), w.kernel(), () => ledger);
  const first = c.applyCertifiedCommit(input(w.steps[0]!));
  const root = ledger.stateRoot().toHex();
  const txCount = ledger.txs.length;
  for (let i = 0; i < 3; i++) assert.deepEqual(c.applyCertifiedCommit(input(w.steps[0]!)), first);
  assert.equal(ledger.stateRoot().toHex(), root);
  assert.equal(ledger.txs.length, txCount);
  assert.equal(c.log.all().length, 2);
});

test("H1 conflict: another block presented for a decided height is rejected and the ledger is unchanged", async () => {
  const w = await world(2);
  const ledger = w.fresh();
  const c = new CertifiedCommitter(new CommitLog(tmp()), w.kernel(), () => ledger);
  const s0 = w.steps[0]!, s1 = w.steps[1]!;
  c.applyCertifiedCommit(input(s0));
  const before = ledger.stateRoot().toHex();
  const forged = { ...input(s1), proposal: { ...s1.proposal, height: s0.proposal.height } };
  assert.throws(() => c.applyCertifiedCommit(forged), /BFT_COMMIT_CONFLICT|BFT_COMMIT_CERTIFICATE_INVALID/);
  assert.equal(ledger.stateRoot().toHex(), before);
});

test("H1 height mismatch is rejected before any write", async () => {
  const w = await world(2);
  const ledger = w.fresh();
  const c = new CertifiedCommitter(new CommitLog(tmp()), w.kernel(), () => ledger);
  assert.throws(() => c.applyCertifiedCommit(input(w.steps[1]!)), /BFT_HEIGHT_MISMATCH/);
  assert.equal(c.log.all().length, 0);
  assert.equal(c.status(w.steps[1]!.proposal.height), "UNKNOWN");
});

test("H1 prior spend: a certified tx already spent outside the certified path is rejected, nothing written", async () => {
  const w = await world(1);
  const ledger = w.fresh();
  assert.ok(!("error" in ledger.submit(w.steps[0]!.tx)));
  const c = new CertifiedCommitter(new CommitLog(tmp()), w.kernel(), () => ledger);
  assert.throws(() => c.applyCertifiedCommit(input(w.steps[0]!)), /BFT_PARENT_STATE_MISMATCH|BFT_TX_ALREADY_APPLIED|NULLIFIER_SPENT/);
  assert.equal(c.log.all().length, 0);
});

test("H1 invalid certificate (too few votes, duplicated/tampered vote) is rejected", async () => {
  const w = await world(1);
  const ledger = w.fresh();
  const c = new CertifiedCommitter(new CommitLog(tmp()), w.kernel(), () => ledger);
  const s = w.steps[0]!;
  assert.throws(() => c.applyCertifiedCommit({ ...input(s), certificate: { ...s.certificate, votes: s.certificate.votes.slice(0, 2) } }), /BFT_COMMIT_CERTIFICATE_INVALID/);
  const bad = structuredClone(s.certificate);
  bad.votes = [bad.votes[0]!, bad.votes[1]!, { ...bad.votes[2]!, signature: "00".repeat(64) }];
  assert.throws(() => c.applyCertifiedCommit({ ...input(s), certificate: bad }), /BFT_COMMIT_CERTIFICATE_INVALID/);
  assert.equal(ledger.stateRoot().toHex(), s.preRoot);
  assert.equal(c.log.all().length, 0);
});

const POINTS: CommitWritePoint[] = ["before-intent", "intent-torn", "after-intent", "after-apply", "applied-torn", "after-applied", "after-kernel-commit"];

for (const point of POINTS) {
  for (const restart of ["same-process", "restart-from-snapshot"] as const) {
    test(`H1 crash at ${point} (${restart}): recovery finishes or never starts the commit, no partial state, no double apply`, async () => {
      const w = await world(2);
      const path = tmp();
      let ledger = w.fresh();
      const s0 = w.steps[0]!;
      let armed = true;
      const c1 = new CertifiedCommitter(new CommitLog(path), w.kernel(), () => ledger, { faultInjector: (p) => { if (armed && p === point) { armed = false; throw new Error("CRASH_INJECTED"); } } });
      assert.throws(() => c1.applyCertifiedCommit(input(s0)), /CRASH_INJECTED/);
      if (restart === "restart-from-snapshot") ledger = w.fresh();
      const log = new CommitLog(path);
      if (point.endsWith("-torn")) assert.ok(log.repairedTornBytes > 0, "torn tail repaired");
      const k = w.kernel();
      const c2 = new CertifiedCommitter(log, k, () => ledger);
      const status = c2.status(s0.proposal.height);
      if (point === "before-intent" || point === "intent-torn") assert.equal(status, "UNKNOWN");
      else if (point === "after-intent" || point === "after-apply" || point === "applied-torn") assert.equal(status, "CERTIFIED_NOT_APPLIED");
      else assert.equal(status, "APPLIED");
      c2.recover();
      if (status === "UNKNOWN") {
        if (restart === "restart-from-snapshot") assert.equal(ledger.stateRoot().toHex(), s0.preRoot, "nothing durable: the ledger is untouched");
        c2.applyCertifiedCommit(input(s0));
      }
      assert.equal(c2.status(s0.proposal.height), "APPLIED");
      assert.equal(ledger.stateRoot().toHex(), s0.postRoot);
      assert.equal(count(ledger, s0), 1, "applied exactly once");
      assert.ok(k.exportState().committed.some(([h, b]) => h === String(s0.proposal.height) && b === s0.proposal.blockId));
      assert.deepEqual(c2.applyCertifiedCommit(input(s0)), c2.result(s0.proposal.height));
      c2.applyCertifiedCommit(input(w.steps[1]!));
      assert.equal(ledger.stateRoot().toHex(), w.steps[1]!.postRoot);
      assert.equal(new CommitLog(path).all().filter(e => e.type === "APPLIED").length, 2);
    });
  }
}

test("H1 recovery from an older snapshot re-applies every APPLIED height in order and checks each root", async () => {
  const w = await world(3);
  const path = tmp();
  const ledger = w.fresh();
  const c = new CertifiedCommitter(new CommitLog(path), w.kernel(), () => ledger);
  for (const s of w.steps) c.applyCertifiedCommit(input(s));
  const again = w.fresh();
  const c2 = new CertifiedCommitter(new CommitLog(path), w.kernel(), () => again);
  assert.equal(c2.recover().reapplied, 3);
  assert.equal(again.stateRoot().toHex(), w.steps[2]!.postRoot);
  assert.equal(c2.recover().reapplied, 0, "second recovery is a no-op");
});

test("H1 a tampered non-tail log entry breaks the hash chain and refuses to start", async () => {
  const w = await world(1);
  const path = tmp();
  const ledger = w.fresh();
  new CertifiedCommitter(new CommitLog(path), w.kernel(), () => ledger).applyCertifiedCommit(input(w.steps[0]!));
  const lines = readFileSync(path, "utf8").split("\n");
  lines[1] = lines[1]!.replace(/"postRoot":"[0-9a-f]{4}/, '"postRoot":"ffff');
  writeFileSync(path, lines.join("\n"));
  assert.throws(() => new CommitLog(path), /COMMIT_LOG_CORRUPT/);
});

test("H1 recovery against a divergent ledger refuses (or aborts) deterministically and never applies", async () => {
  const w = await world(2);
  const path = tmp();
  let armed = true;
  const first = w.fresh();
  const c1 = new CertifiedCommitter(new CommitLog(path), w.kernel(), () => first, { faultInjector: (p) => { if (armed && p === "after-intent") { armed = false; throw new Error("CRASH_INJECTED"); } } });
  assert.throws(() => c1.applyCertifiedCommit(input(w.steps[0]!)), /CRASH_INJECTED/);
  // A ledger that moved to another state: step 0 and step 1 applied outside the commit path.
  const other = w.fresh();
  assert.ok(!("error" in other.submit(w.steps[0]!.tx)));
  assert.ok(!("error" in other.submit(w.steps[1]!.tx)));
  const root = other.stateRoot().toHex();
  const c2 = new CertifiedCommitter(new CommitLog(path), w.kernel(), () => other);
  assert.throws(() => c2.recover(), /BFT_RECOVERY_DIVERGED/);
  assert.equal(other.stateRoot().toHex(), root);
  assert.equal(count(other, w.steps[0]!), 1);
});

test("H1 migration: a 0.5.80 bft-commit-journal.json (v1) becomes INTENT entries and recovers to the same root", async () => {
  const w = await world(2);
  const dir = mkdtempSync(join(tmpdir(), "uep-h1-mig-")); dirs.push(dir);
  const journal = join(dir, "bft-commit-journal.json");
  writeFileSync(journal, JSON.stringify({ version: 1, records: w.steps.map((s, i) => ({ proposal: s.proposal, proposalSignature: s.proposalSignature, certificate: s.certificate, tx: txToWire(s.tx), applied: i === 0 })) }));
  const log = new CommitLog(join(dir, "bft-commit-log.jsonl"));
  assert.equal(migrateJournalV1(journal, log), 2);
  assert.ok(log.all().every(e => e.migratedFrom === "bft-commit-journal-v1"));
  const ledger = w.fresh();
  const c = new CertifiedCommitter(log, w.kernel(), () => ledger);
  c.recover();
  assert.equal(ledger.stateRoot().toHex(), w.steps[1]!.postRoot);
  assert.equal(c.status(w.steps[1]!.proposal.height), "APPLIED");
  assert.equal(migrateJournalV1(journal, log), 0, "migration runs once");
});

/** Deterministic xorshift32 PRNG; the seed is part of the test name. */
function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; }; }

for (const seed of [1, 7, 42, 2026, 31337]) {
  test(`H1 property (seed ${seed}): random replays, crashes and restarts never apply a certified tx twice; final root matches the reference`, async () => {
    const w = await world(4);
    const r = rng(seed);
    const path = tmp();
    let ledger = w.fresh();
    let next = 0;
    let crashPoint: CommitWritePoint | undefined;
    const make = () => new CertifiedCommitter(new CommitLog(path), w.kernel(), () => ledger, { faultInjector: (p) => { if (p === crashPoint) { crashPoint = undefined; throw new Error("CRASH_INJECTED"); } } });
    let c = make();
    for (let op = 0; op < 40 && next < w.steps.length; op++) {
      const roll = r();
      if (roll < 0.25 && next > 0) {
        const old = Math.floor(r() * next);
        const before = ledger.stateRoot().toHex();
        c.applyCertifiedCommit(input(w.steps[old]!));
        assert.equal(ledger.stateRoot().toHex(), before, "replay never changes balances");
      } else if (roll < 0.45) {
        crashPoint = POINTS[Math.floor(r() * POINTS.length)];
        try { c.applyCertifiedCommit(input(w.steps[next]!)); } catch (e) { assert.match((e as Error).message, /CRASH_INJECTED/); }
        crashPoint = undefined;
        if (r() < 0.5) ledger = w.fresh();
        c = make();
        c.recover();
      } else {
        c.applyCertifiedCommit(input(w.steps[next]!));
      }
      while (next < w.steps.length && c.status(w.steps[next]!.proposal.height) === "APPLIED") next++;
      for (const s of w.steps) assert.ok(count(ledger, s) <= 1, "never applied twice");
    }
    while (next < w.steps.length) { c.applyCertifiedCommit(input(w.steps[next]!)); next++; }
    assert.equal(ledger.stateRoot().toHex(), w.steps.at(-1)!.postRoot);
    for (const s of w.steps) assert.equal(count(ledger, s), 1);
  });
}
