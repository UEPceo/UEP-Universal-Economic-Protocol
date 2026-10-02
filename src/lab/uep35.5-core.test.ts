import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ScaleMempool,
  txByteSize,
  batchDigest,
} from "./uep35-scale-mempool.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  accessSetFromTx,
  accessesConflict,
  partitionByConflictGraph,
} from "./uep35-conflict-graph.ts";
import { UepWorker } from "./uep35-worker.ts";
import { BatchDag } from "./uep35-dag.ts";
import {
  sequentialExecution,
  parallelExecution,
  snapshotsEqual,
  executionStateCommitment,
} from "./uep35-batch-execute.ts";
import {
  commitAndFinalizeBatch,
  assertCertMatchesBatch,
  batchProposalBinding,
} from "./uep35-batch-finality.ts";
import { createNodeIdentity } from "./node-identity.ts";
import { FinalityBoundLedger } from "./uep35-ledger-finality.ts";
import { creatorFee } from "../core/fee.ts";

describe("UEP-35.5 mempool maxBatchBytes", () => {
  it("respects size and byte limits; oversized TX rejected", () => {
    const mp = new ScaleMempool({ maxBatchSize: 100, maxBatchBytes: 80, maxPending: 1000 });
    // small txs
    for (let i = 0; i < 20; i++) {
      assert.equal(
        mp.admit({ id: `s${i}`, from: "a", to: "b", amount: 1n }).ok,
        true,
      );
    }
    const b = mp.takeBatch();
    assert.ok(b.length >= 1);
    assert.ok(b.reduce((s, t) => s + txByteSize(t), 0) <= 80);
    // exact fill residual still ok
    const bigId = "X".repeat(200);
    const r = mp.admit({ id: bigId, from: "a", to: "b", amount: 1n });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "TX_TOO_LARGE");
    // mempool still drains
    mp.admit({ id: "tiny", from: "a", to: "b", amount: 1n });
    const b2 = mp.takeBatch();
    assert.ok(b2.length >= 1);
  });

  it("mempool dedup ≠ ledger replay: intake forgets after takeBatch", () => {
    const mp = new ScaleMempool({ maxBatchSize: 10, maxBatchBytes: 10_000, maxPending: 100 });
    const tx: BatchTx = { id: "same-id", from: "a", to: "b", amount: 1n };
    assert.equal(mp.admit(tx).ok, true);
    assert.equal(mp.admit(tx).ok, false); // intake dedup
    const batch = mp.takeBatch();
    assert.equal(batch.length, 1);
    // After take, intake seen cleared — can re-admit same id at mempool layer
    assert.equal(mp.hasIntakeSeen("same-id"), false);
    assert.equal(mp.admit(tx).ok, true);
    // Protocol replay still must be enforced by nullifier/transition at ledger — demonstrated in finality tests
  });
});

describe("UEP-35.5 conflict graph", () => {
  it("detects write-write conflict and allows independent parallel", () => {
    const t1: BatchTx = { id: "1", from: "A", to: "X", amount: 1n };
    const t2: BatchTx = { id: "2", from: "B", to: "X", amount: 1n };
    const t3: BatchTx = { id: "3", from: "C", to: "D", amount: 1n };
    assert.equal(accessesConflict(accessSetFromTx(t1), accessSetFromTx(t2)), true);
    assert.equal(accessesConflict(accessSetFromTx(t1), accessSetFromTx(t3)), false);
    const waves = partitionByConflictGraph([t1, t2, t3]);
    assert.ok(waves.length >= 2);
    // t3 can share wave with one of t1/t2
    const flat = waves.flat().map((t) => t.id).sort();
    assert.deepEqual(flat, ["1", "2", "3"]);
  });
});

describe("UEP-35.5 worker + DAG + recovery", () => {
  it("produce, header announce, recover body with digest check", () => {
    const a = new UepWorker({ workerId: "wa", epoch: 0, mempool: { maxBatchSize: 10, maxBatchBytes: 50_000 } });
    const b = new UepWorker({ workerId: "wb", epoch: 0 });
    for (let i = 0; i < 5; i++) {
      a.admit({ id: `t${i}`, from: "alice", to: "bob", amount: 1n });
    }
    const produced = a.produceBatch();
    assert.ok(produced);
    const { header, txs } = produced!;
    assert.equal(b.announceHeader(header).ok, true);
    assert.equal(b.dag.hasBody(header.batchId), false);
    // recovery
    const reqId = "req-1";
    const resp = a.respondBatch(header.batchId, reqId);
    assert.equal(resp.ok, true);
    // duplicate request
    assert.equal(a.respondBatch(header.batchId, reqId).ok, false);
    const ing = b.ingestRecovery(header, (resp as { txs: BatchTx[] }).txs);
    assert.equal(ing.ok, true);
    assert.equal(b.dag.hasBody(header.batchId), true);
    // corrupt body
    const bad = [...txs];
    bad[0] = { ...bad[0]!, amount: 999n };
    const c = new UepWorker({ workerId: "wc", epoch: 0 });
    c.announceHeader(header);
    assert.equal(c.ingestRecovery(header, bad).ok, false);
  });

  it("rejects cyclic and conflicting headers", () => {
    const dag = new BatchDag();
    const h1 = {
      batchId: "b1",
      epoch: 0,
      height: 1,
      parents: [],
      txCount: 0,
      byteSize: 0,
      txDigest: "d1",
      producerId: "w",
      ts: 1,
    };
    assert.equal(dag.acceptHeader(h1).ok, true);
    assert.equal(
      dag.acceptHeader({ ...h1, batchId: "b2", parents: ["b2"], txDigest: "d2" }).ok,
      false,
    );
    assert.equal(
      dag.acceptHeader({ ...h1, txDigest: "other" }).ok,
      false,
    );
  });
});

describe("UEP-35.5 sequential vs parallel oracle", () => {
  it("same commitment for independent txs", async () => {
    const accounts = [
      { label: "s0", balance: 1000n },
      { label: "s1", balance: 1000n },
      { label: "r0", balance: 0n },
      { label: "r1", balance: 0n },
    ];
    const txs: BatchTx[] = [
      { id: "p0", from: "s0", to: "r0", amount: 10n },
      { id: "p1", from: "s1", to: "r1", amount: 20n },
    ];
    const seq = await sequentialExecution(accounts, txs);
    const par = await parallelExecution(accounts, txs);
    assert.equal(snapshotsEqual(seq.snapshot, par.snapshot), true);
    assert.equal(seq.snapshot.acceptedIds.length, 2);
    assert.ok(par.waves >= 1);
  });
});

describe("UEP-35.5 batch → CommitCert → Finality → economy", () => {
  it("full pipeline binding and applyOnFinal", async () => {
    const accounts = [
      { label: "alice", balance: 1000n },
      { label: "bob", balance: 0n },
    ];
    const txs: BatchTx[] = [
      { id: "tx1", from: "alice", to: "bob", amount: 50n },
    ];
    const exec = await sequentialExecution(accounts, txs);
    const postRoot = exec.snapshot.commitment;
    const worker = new UepWorker({ workerId: "w0", epoch: 1 });
    worker.admit(txs[0]!);
    const produced = worker.produceBatch();
    assert.ok(produced);
    // attach post root conceptually
    const header = { ...produced!.header, postStateRoot: postRoot };

    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`n${i}`));
    const { cert, finality, verifyOk, proposal } = commitAndFinalizeBatch({
      leader: ids[0]!,
      finalizers: ids,
      header,
      postStateRoot: postRoot,
    });
    assert.equal(verifyOk, true);
    assert.equal(assertCertMatchesBatch(cert, header, postRoot).ok, true);
    // mismatch tests
    assert.equal(assertCertMatchesBatch(cert, header, "WRONG-ROOT").ok, false);
    assert.equal(
      assertCertMatchesBatch(cert, { ...header, height: 99 }, postRoot).ok,
      false,
    );

    // Economic apply only after finality
    const ledger = new FinalityBoundLedger({ alice: 1000n, bob: 0n });
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const total0 = ledger.total();
    const fee = creatorFee(50n);
    const r = ledger.applyOnFinal(
      finality,
      {
        sequence: finality.sequence,
        from: "alice",
        to: "bob",
        amount: 50n,
        nullifier: proposal.nullifier,
        transitionId: proposal.transitionId,
        stateRoot: finality.stateRoot,
        proposalDigest: proposal.digest,
      },
      ids.map((x) => x.nodeId),
      (id) => keys[id],
    );
    assert.equal(r.ok, true, (r as { reason?: string }).reason);
    assert.equal(ledger.balance("bob"), 50n);
    assert.equal(ledger.balance("alice"), 1000n - 50n - fee);
    assert.equal(ledger.total(), total0);
    // idempotent
    assert.equal(
      ledger.applyOnFinal(
        finality,
        {
          sequence: finality.sequence,
          from: "alice",
          to: "bob",
          amount: 50n,
          nullifier: proposal.nullifier,
          transitionId: proposal.transitionId,
          stateRoot: finality.stateRoot,
          proposalDigest: proposal.digest,
        },
        ids.map((x) => x.nodeId),
        (id) => keys[id],
      ).ok,
      true,
    );
    assert.equal(ledger.balance("bob"), 50n);
  });
});
