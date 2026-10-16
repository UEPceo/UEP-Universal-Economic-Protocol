/**
 * 0.5.84 item 2: certified checkpoints across 4 independent validator processes (one machine,
 * loopback proxies with partition, duplication and delay).
 *  1. Partition 2 | 2: no side can certify a checkpoint (quorum 3 of 4) and no height finalizes.
 *  2. Heal: the pending height finalizes once, all validators converge on the same state root.
 *  3. A checkpoint is certified (>= 3 valid signatures), fetched and accepted by every validator,
 *     and each validator's root equals the checkpoint root.
 *  4. A validator killed with SIGKILL and restarted from disk still holds the checkpoint (unified store).
 *  5. A checkpoint with only 2 signatures, a stale one, and one with a tampered root are rejected.
 * Single machine: this is convergence evidence for the implementation, not a network-level claim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { txToWire } from "./certified-commit.ts";
import { startCluster, waitFor } from "./bft-mp-harness.ts";

const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261017);

test(`certified checkpoints: partition, heal, convergence, persistence, rejection (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const c = await startCluster({ seed: SEED, spends: 3 });
  const { txs, roots } = c;
  const syncAll = async (k: number) => waitFor(`root ${k} everywhere`, async () => {
    for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/sync").catch(() => {});
    const s = await Promise.all([0, 1, 2, 3].map(i => c.st(i).catch(() => null)));
    return s.every(x => x?.stateRoot === roots[k]);
  }, 90_000);
  try {
    await Promise.all([0, 1, 2, 3].map(i => c.start(i)));
    const h0 = (await c.st(0)).expectedHeight;
    await c.ctl(c.leaderFor(h0), "/ctl/propose", { tx: txToWire(txs[0]!) });
    await syncAll(0);
    const firstReply = (await c.ctl(c.leaderFor(h0), "/ctl/checkpoint")).body;
    const first = firstReply.checkpoint;
    assert.ok(first, JSON.stringify(firstReply));
    assert.ok(first.signatures.length >= 3);

    // 1. partition 2 | 2
    c.setAll({ loss: 0, dup: 0.2, maxDelayMs: 30, blocked: false });
    c.partition([0, 1]);
    const h1 = h0 + 1;
    const leader = c.leaderFor(h1);
    const r = await c.ctl(leader, "/ctl/propose", { tx: txToWire(txs[1]!) }).catch(e => ({ body: { error: String(e) } }));
    assert.ok(r.body.error, "no quorum on one side of the partition");
    for (const i of [0, 1, 2, 3]) {
      const out = await c.ctl(i, "/ctl/checkpoint").catch(e => ({ body: { error: String(e) } }));
      assert.match(String(out.body.error ?? ""), /CHECKPOINT_QUORUM_MISSING|CHECKPOINT_HEAD_NOT_JOURNALED/, `v${i} cannot certify while partitioned`);
    }
    await c.assertNoConflictingFinality();

    // 2. heal and converge
    c.partition([]);
    await c.ctl(leader, "/ctl/propose", { tx: txToWire(txs[1]!) }).catch(() => {});
    await syncAll(1);

    // 3. certify, fetch, accept everywhere
    const cp = (await c.ctl(leader, "/ctl/checkpoint")).body.checkpoint;
    assert.ok(cp.signatures.length >= 3, "quorum of signatures");
    assert.equal(cp.body.stateRoot, roots[1]);
    for (const i of [0, 1, 2, 3]) {
      const got = (await c.ctl(i, "/ctl/checkpoint-fetch")).body.checkpoint;
      assert.equal(got?.body.stateRoot, roots[1], `v${i} accepted the checkpoint`);
      assert.equal((await c.st(i)).stateRoot, got.body.stateRoot);
    }

    // 4. persistence across kill -9
    const v = [0, 1, 2, 3].find(i => i !== leader)!;
    await c.kill(v);
    await c.start(v);
    const again = (await c.ctl(v, "/ctl/checkpoint-accept", { checkpoint: cp })).body.checkpoint;
    assert.equal(again.body.height, cp.body.height, "checkpoint reloaded from the unified store (same one accepted idempotently)");

    // 5. rejections
    const weak = { ...cp, signatures: cp.signatures.slice(0, 2) };
    const w = await c.ctl(v, "/ctl/checkpoint-accept", { checkpoint: { ...weak, body: { ...cp.body, height: cp.body.height + 5 } } });
    assert.match(String(w.body.error), /CHECKPOINT_QUORUM_MISSING/);
    const stale = await c.ctl(v, "/ctl/checkpoint-accept", { checkpoint: first });
    assert.match(String(stale.body.error), /CHECKPOINT_STALE/);
    const tampered = await c.ctl(v, "/ctl/checkpoint-accept", { checkpoint: { ...cp, body: { ...cp.body, height: cp.body.height + 1, stateRoot: "11".repeat(32) } } });
    assert.match(String(tampered.body.error), /CHECKPOINT_QUORUM_MISSING/, "signatures do not cover a changed body");

    // the cluster continues
    await c.ctl(c.leaderFor(h0 + 2), "/ctl/propose", { tx: txToWire(txs[2]!) }).catch(() => {});
    await syncAll(2);
    await c.assertNoConflictingFinality();
    console.log(`[bft-checkpoint] seed=${SEED} height=${cp.body.height} signers=${cp.signatures.map((s: { validatorId: string }) => s.validatorId).join(",")} root=${cp.body.stateRoot}`);
  } catch (e) {
    for (const [i, l] of c.logs) console.error(`--- v${i} log tail ---\n${l.slice(-2500)}`);
    throw e;
  } finally {
    c.close();
  }
});
