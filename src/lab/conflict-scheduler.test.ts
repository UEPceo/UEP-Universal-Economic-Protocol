import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  partitionIntoWaves,
  jobsConflict,
  scheduleStats,
  DEFAULT_CONFLICT_MODE,
  type PendingJob,
} from "./conflict-scheduler.ts";
import { ExecutionEngine } from "./execution-engine.ts";
import { findUepZkBinary } from "./zk-bridge.ts";

function job(seq: number, from: string, to: string, amount = 100n): PendingJob {
  return {
    seq,
    fee: 0n,
    intent: { id: `t${seq}`, from, to, amount },
  };
}

describe("UEP-30.2 conflict scheduler unit", () => {
  it("same sender conflicts; different senders do not", () => {
    const a = job(0, "alice", "bob");
    const b = job(1, "alice", "carol");
    const c = job(2, "eve", "frank");
    assert.equal(jobsConflict(a, b, DEFAULT_CONFLICT_MODE), true);
    assert.equal(jobsConflict(a, c, DEFAULT_CONFLICT_MODE), false);
  });

  it("partitions into minimal waves by sender conflicts", () => {
    const jobs = [
      job(0, "alice", "bob"),
      job(1, "alice", "carol"),
      job(2, "eve", "frank"),
      job(3, "gina", "hank"),
    ];
    const waves = partitionIntoWaves(jobs);
    // wave0: alice, eve, gina (alice only once)
    assert.equal(waves[0]!.length, 3);
    assert.equal(waves[1]!.length, 1);
    assert.equal(waves[1]![0]!.intent.from, "alice");
    const st = scheduleStats(jobs);
    assert.equal(st.waveCount, 2);
    assert.equal(st.maxWaveSize, 3);
  });
});

describe("UEP-30.2 scheduled execution structural", () => {
  it("independent senders one wave; same sender two waves", async () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 4,
      oneInFlightPerSender: false,
    });
    for (const s of ["alice", "eve"]) {
      eng.registerAccount(s, {
        secret: Fr.from(BigInt(s.charCodeAt(0))),
        salt: Fr.from(1n),
        blinding: Fr.from(2n),
        balance: 50_000n,
      });
    }
    for (const r of ["bob", "carol", "frank"]) {
      eng.registerAccount(r, {
        secret: Fr.from(BigInt(r.charCodeAt(0) * 10)),
        salt: Fr.from(1n),
        blinding: Fr.from(3n),
        balance: 0n,
      });
    }
    eng.enqueue({ id: "1", from: "alice", to: "bob", amount: 100n });
    eng.enqueue({ id: "2", from: "alice", to: "carol", amount: 100n });
    eng.enqueue({ id: "3", from: "eve", to: "frank", amount: 100n });
    const peek = eng.peekSchedule();
    assert.equal(peek.waveCount, 2);
    assert.deepEqual(peek.waves, [2, 1]); // alice+eve, then alice again
    const before = eng.totalBalances();
    const { waves, commits, failed } = await eng.runScheduled();
    assert.equal(failed.length, 0);
    assert.equal(waves, 2);
    assert.equal(commits.filter((c) => c.ok).length, 3);
    assert.equal(eng.totalBalances(), before);
  });
});

describe("UEP-30.2 scheduled ZK independent senders (no SKIP)", () => {
  it("two independent senders prove in one wave", async () => {
    assert.ok(findUepZkBinary(), "uep-zk binary required");
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: true,
      proveConcurrency: 2,
      seedBase: 900,
      oneInFlightPerSender: true,
    });
    eng.registerAccount("alice", {
      id: Fr.from(111n),
      secret: Fr.from(11n),
      salt: Fr.from(22n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    eng.registerAccount("carol", {
      id: Fr.from(13n),
      secret: Fr.from(77n),
      salt: Fr.from(88n),
      blinding: Fr.from(7n),
      balance: 50_000n,
    });
    eng.registerAccount("bob", {
      id: Fr.from(222n),
      secret: Fr.from(33n),
      salt: Fr.from(44n),
      blinding: Fr.from(4n),
      balance: 0n,
    });
    eng.bootstrapZeroNotes();
    eng.enqueue({ id: "a", from: "alice", to: "bob", amount: 1000n });
    eng.enqueue({ id: "c", from: "carol", to: "bob", amount: 1000n });
    const peek = eng.peekSchedule();
    assert.equal(peek.waveCount, 1);
    assert.equal(peek.maxWaveSize, 2);
    const before = eng.totalBalances();
    const t0 = performance.now();
    const { waves, commits, failed, proved, staleRetries } = await eng.runScheduled();
    const wall = performance.now() - t0;
    assert.equal(failed.length, 0, JSON.stringify(failed));
    assert.equal(waves, 1);
    const okCommits = commits.filter((c) => c.ok);
    assert.equal(okCommits.length, 2, JSON.stringify(commits));
    assert.equal(eng.totalBalances(), before);
    assert.ok(proved.every((p) => (p.proveMs ?? 0) > 0));
    // ZK wave is sequential commit (roots not composable); still one conflict-wave
    assert.equal(staleRetries, 0);
    assert.ok(wall < 30_000, `wall ${wall}`);
  });
});
