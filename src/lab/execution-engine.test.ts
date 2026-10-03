import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { ExecutionEngine } from "./execution-engine.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import { creatorFee } from "../core/fee.ts";
import { normalizeFrHex } from "./zk-public-inputs.ts";

describe("UEP-30.0 structural parallel engine", () => {
  it("reserves, proves in parallel, commits serially, conserves value", async () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 4,
      oneInFlightPerSender: false,
    });
    const n = 8;
    for (let i = 0; i < n; i++) {
      eng.registerAccount(`s${i}`, {
        secret: Fr.from(BigInt(10 + i)),
        salt: Fr.from(BigInt(20 + i)),
        blinding: Fr.from(BigInt(3 + i)),
        balance: 100_000n,
      });
      eng.registerAccount(`r${i}`, {
        secret: Fr.from(BigInt(100 + i)),
        salt: Fr.from(BigInt(200 + i)),
        blinding: Fr.from(BigInt(4 + i)),
        balance: 0n,
      });
    }
    const before = eng.totalBalances();
    for (let i = 0; i < n; i++) {
      assert.equal(
        eng.enqueue({ id: `tx-${i}`, from: `s${i}`, to: `r${i}`, amount: 1000n }).ok,
        true,
      );
    }
    const { commits, failed } = await eng.runRound();
    assert.equal(failed.length, 0);
    assert.equal(commits.filter((c) => c.ok).length, n);
    assert.equal(eng.totalBalances(), before);
  });

  it("rejects over-reservation at enqueue", () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 2,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 1500n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    assert.equal(eng.enqueue({ id: "1", from: "a", to: "b", amount: 1000n }).ok, true);
    assert.equal(eng.enqueue({ id: "2", from: "a", to: "b", amount: 1000n }).ok, false);
  });

  it("idempotent transitionId rejected on second commit", async () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 2,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    eng.enqueue({ id: "x", from: "a", to: "b", amount: 100n });
    const { proved } = await eng.provePending();
    assert.equal(eng.commitProved(proved)[0]!.ok, true);
    assert.equal(eng.commitProved(proved)[0]!.error, "IDEMPOTENT_REPLAY");
  });
});

describe("UEP-30.1 one-in-flight per sender", () => {
  it("rejects second enqueue from same sender when policy on", () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 2,
      oneInFlightPerSender: true,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    assert.equal(eng.enqueue({ id: "1", from: "a", to: "b", amount: 100n }).ok, true);
    const e2 = eng.enqueue({ id: "2", from: "a", to: "b", amount: 100n });
    assert.equal(e2.ok, false);
    assert.equal((e2 as { error: string }).error, "ONE_IN_FLIGHT_PER_SENDER");
  });

  it("allows second enqueue after commit completes", async () => {
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: false,
      proveConcurrency: 2,
      oneInFlightPerSender: true,
    });
    eng.registerAccount("a", {
      secret: Fr.from(1n),
      salt: Fr.from(2n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    eng.registerAccount("b", {
      secret: Fr.from(4n),
      salt: Fr.from(5n),
      blinding: Fr.from(6n),
      balance: 0n,
    });
    eng.enqueue({ id: "1", from: "a", to: "b", amount: 100n });
    await eng.runRound();
    assert.equal(eng.enqueue({ id: "2", from: "a", to: "b", amount: 100n }).ok, true);
  });
});

describe("UEP-30.1 canonical ZK chain (no SKIP)", () => {
  it("recipient_id binds to real recipient, not hardcoded 33", async () => {
    assert.ok(findUepZkBinary(), "uep-zk binary required");
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: true,
      proveConcurrency: 1,
      seedBase: 700,
    });
    eng.registerAccount("alice", {
      id: Fr.from(112n), // its depth-4 state slot differs from the treasury slot
      secret: Fr.from(11n),
      salt: Fr.from(22n),
      blinding: Fr.from(3n),
      balance: 50_000n,
    });
    // carol is NOT 33
    eng.registerAccount("carol", {
      id: Fr.from(222n),
      secret: Fr.from(55n),
      salt: Fr.from(66n),
      blinding: Fr.from(7n),
      balance: 0n,
    });
    eng.bootstrapZeroNotes();
    eng.enqueue({ id: "t1", from: "alice", to: "carol", amount: 1000n });
    const { proved, failed, commits } = await eng.runRound();
    assert.equal(failed.length, 0, JSON.stringify(failed));
    assert.equal(commits[0]!.ok, true);
    const rec = normalizeFrHex(proved[0]!.publicInputsHex[5]!);
    assert.equal(rec, normalizeFrHex(Fr.from(222n).toHex()));
    assert.notEqual(rec, normalizeFrHex(Fr.from(33n).toHex()));
  });

  it("TX1→TX2→TX3 chains state roots; treasury accumulates fees", async () => {
    assert.ok(findUepZkBinary(), "uep-zk binary required");
    const eng = new ExecutionEngine({
      depth: 4,
      profile: "local",
      requireProof: true,
      proveConcurrency: 1,
      seedBase: 800,
      oneInFlightPerSender: true,
    });
    eng.registerAccount("alice", {
      id: Fr.from(112n), // its depth-4 state slot differs from the treasury slot
      secret: Fr.from(11n),
      salt: Fr.from(22n),
      blinding: Fr.from(3n),
      balance: 100_000n,
    });
    eng.registerAccount("bob", {
      id: Fr.from(222n),
      secret: Fr.from(33n),
      salt: Fr.from(44n),
      blinding: Fr.from(4n),
      balance: 0n,
    });
    eng.bootstrapZeroNotes();
    const before = eng.totalBalances();
    const roots: string[] = [];
    for (let i = 0; i < 3; i++) {
      eng.enqueue({ id: `tx${i}`, from: "alice", to: "bob", amount: 1000n });
      const { commits, failed, proved } = await eng.runRound();
      assert.equal(failed.length, 0, JSON.stringify(failed));
      assert.equal(commits[0]!.ok, true, commits[0]!.error);
      roots.push(proved[0]!.newStateRoot);
      if (i > 0) {
        assert.equal(
          normalizeFrHex(proved[0]!.oldStateRoot),
          normalizeFrHex(roots[i - 1]!),
          "old root must equal previous new root",
        );
      }
    }
    assert.equal(eng.totalBalances(), before);
    const fee = creatorFee(1000n);
    assert.equal(eng.treasuryBalance, fee * 3n);
    assert.ok(eng.stateRoot);
    assert.notEqual(roots[0], roots[2]);
  });
});
