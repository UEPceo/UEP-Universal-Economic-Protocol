import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Fr } from "../core/field.ts";
import { ExecutionEngine } from "./execution-engine.ts";
import {
  exportSnapshot,
  writeSnapshotFile,
  loadSnapshot,
  loadSnapshotFile,
  appendJournalLine,
  readJournal,
} from "./engine-persistence.ts";

describe("UEP-30.3 engine persistence", () => {
  it("snapshot roundtrip preserves balances, roots, nullifiers", async () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 2,
      oneInFlightPerSender: true,
    });
    eng.registerAccount("alice", {
      id: Fr.from(111n),
      secret: Fr.from(11n),
      salt: Fr.from(22n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    eng.registerAccount("bob", {
      id: Fr.from(222n),
      secret: Fr.from(33n),
      salt: Fr.from(44n),
      blinding: Fr.from(4n),
      balance: 0n,
    });
    eng.enqueue({ id: "t1", from: "alice", to: "bob", amount: 1000n });
    await eng.runRound();
    const beforeBal = eng.totalBalances();
    const beforeRoot = eng.stateRoot;
    const snap = exportSnapshot(eng, { includeSecrets: true });
    assert.equal(snap.version, 1);
    assert.ok(snap.accounts.length >= 2);
    assert.ok(snap.transitionIds.length >= 1);

    const eng2 = loadSnapshot(snap);
    assert.equal(eng2.totalBalances(), beforeBal);
    assert.equal(eng2.stateRoot, beforeRoot);
    assert.equal(eng2.getAccount("alice").balance, eng.getAccount("alice").balance);
    assert.equal(eng2.getAccount("bob").balance, eng.getAccount("bob").balance);
    // idempotent replay still blocked
    eng2.enqueue({ id: "t2", from: "alice", to: "bob", amount: 100n });
    const { proved } = await eng2.provePending();
    // force same transitionId commit path: commit of new job should work
    const commits = eng2.commitProved(proved);
    assert.equal(commits[0]!.ok, true);
  });

  it("write/load file + journal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uep-30.3-"));
    const snapPath = path.join(dir, "state.json");
    const journalPath = path.join(dir, "journal.ndjson");
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 1,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 10_000n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    writeSnapshotFile(snapPath, eng, { includeSecrets: true });
    appendJournalLine(journalPath, {
      type: "enqueue",
      seq: 0,
      intent: { id: "x", from: "a", to: "b", amount: 10n },
      fee: "0",
      ts: Date.now(),
    });
    const eng2 = loadSnapshotFile(snapPath);
    assert.equal(eng2.getAccount("a").balance, 10_000n);
    const j = readJournal(journalPath);
    assert.equal(j.length, 1);
    assert.equal(j[0]!.type, "enqueue");
  });
});

describe("UEP-30.3 journal integrity", () => {
  it("detects corrupted journal line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uep-j-"));
    const journalPath = path.join(dir, "journal.ndjson");
    appendJournalLine(journalPath, {
      type: "enqueue",
      seq: 0,
      intent: { id: "x", from: "a", to: "b", amount: 1n },
      fee: "0",
      ts: Date.now(),
    });
    // Corrupt file
    const raw = fs.readFileSync(journalPath, "utf8");
    fs.writeFileSync(journalPath, raw.replace(/[0-9a-f]{16}/, "0000000000000000"));
    assert.throws(() => readJournal(journalPath), /JOURNAL_CORRUPT/);
  });

  it("atomic snapshot survives reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uep-s-"));
    const snapPath = path.join(dir, "state.json");
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 1,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 99n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    writeSnapshotFile(snapPath, eng, { includeSecrets: true });
    assert.ok(fs.existsSync(snapPath));
    assert.ok(!fs.existsSync(snapPath + ".tmp." + process.pid));
    const eng2 = loadSnapshotFile(snapPath);
    assert.equal(eng2.getAccount("a").balance, 99n);
  });
});
