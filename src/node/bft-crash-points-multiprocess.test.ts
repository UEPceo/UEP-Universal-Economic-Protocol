/**
 * 0.5.83 Block C: crash injection at every write point between the certificate, the commit-log
 * (journal) INTENT, the ledger apply, the APPLIED entry and the kernel commit, in real validator
 * processes killed with SIGKILL (kill -9) and restarted from their own disk.
 *
 * For each point P the victim (a non-leader) is started with UEP_CRASH_AT=P@h. The leader commits
 * height h (3 of 4 validators suffice); the victim receives the commit certificate and dies at P.
 * Then:
 *   1. restart: recovery runs at start; /ctl/audit re-opens the log from disk (hash chain verified),
 *      checks consecutive heights, ledger txs == APPLIED blocks in order, pre/post-root chain, and
 *      the state root against the last APPLIED post-root; the root must equal the reference ledger;
 *   2. kill -9 again and restart: recovery must be idempotent (same log head, entries, root, finality);
 *   3. the cluster commits the next height with the victim participating.
 * Reproduce: UEP_BFT_FAULT_SEED=<seed> node --experimental-strip-types --test src/node/bft-crash-points-multiprocess.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { txToWire } from "./certified-commit.ts";
import { startCluster, waitFor } from "./bft-mp-harness.ts";

const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261015);
const POINTS = ["before-intent", "intent-torn", "after-intent", "after-apply", "applied-torn", "after-applied", "after-kernel-commit"] as const;

test(`Block C: SIGKILL at each commit write point, restart, idempotent recovery, continuity and state root (seed ${SEED})`, { timeout: 900_000 }, async () => {
  const c = await startCluster({ seed: SEED, spends: POINTS.length + 1 });
  const { txs, roots } = c;
  const results: Record<string, unknown>[] = [];
  try {
    await Promise.all([0, 1, 2, 3].map(i => c.start(i)));
    const h0 = (await c.st(0)).expectedHeight;
    c.setAll({ loss: 0, dup: 0.2, maxDelayMs: 40, blocked: false }); // duplicates + reordering, no loss (crash is the fault here)
    for (const [k, point] of POINTS.entries()) {
      const h = h0 + k;
      const leader = c.leaderFor(h);
      const victim = [0, 1, 2, 3].find(i => i !== leader && i !== c.leaderFor(h + 1))!;
      await c.kill(victim);
      await c.start(victim, { UEP_CRASH_AT: `${point}@${h}` });
      await c.ctl(victim, "/ctl/sync");
      const died = c.exited(victim);
      await c.ctl(leader, "/ctl/propose", { tx: txToWire(txs[k]!) }).catch(() => {});
      const exit = await Promise.race([died, new Promise<null>(f => setTimeout(() => f(null), 30_000))]);
      assert.ok(exit && exit.signal === "SIGKILL", `v${victim} was killed at ${point} (got ${JSON.stringify(exit)})`);
      await c.assertNoConflictingFinality();

      // 1. restart and recover
      await c.start(victim);
      const a1 = (await c.ctl(victim, "/ctl/audit")).body;
      assert.equal(a1.ok, true, `audit after ${point}: ${a1.problems}`);
      assert.deepEqual(a1.pending, [], "no certified height left unapplied");
      // A crash before the INTENT leaves nothing for h; the victim catches up by sync (certificate is final elsewhere).
      await c.ctl(victim, "/ctl/sync");
      const a1s = (await c.ctl(victim, "/ctl/audit")).body;
      assert.equal(a1s.ok, true, `audit after sync (${point}): ${a1s.problems}`);
      assert.equal(a1s.stateRoot, roots[k], `state root after ${point}`);
      assert.equal(a1s.status[String(h)], "APPLIED");

      // 2. kill -9 again: recovery twice gives the same result
      await c.kill(victim);
      await c.start(victim);
      const a2 = (await c.ctl(victim, "/ctl/audit")).body;
      assert.equal(a2.ok, true);
      for (const f of ["head", "entries", "stateRoot", "txCount"] as const) assert.equal(a2[f], a1s[f], `idempotent recovery (${point}): ${f}`);
      assert.deepEqual(a2.committed, a1s.committed);
      results.push({ point, height: h, victim: `v${victim}`, repairedTornBytes: a1.repairedTornBytes, recoveredAtStart: a1.recoveredAtStart, head: a2.head, stateRoot: a2.stateRoot });
    }
    // 3. the cluster continues with every validator
    const hn = h0 + POINTS.length;
    await c.ctl(c.leaderFor(hn), "/ctl/propose", { tx: txToWire(txs[POINTS.length]!) });
    await waitFor("final height everywhere", async () => {
      for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/sync");
      const s = await Promise.all([0, 1, 2, 3].map(i => c.st(i)));
      return s.every(x => x.stateRoot === roots[POINTS.length]);
    }, 60_000);
    for (const i of [0, 1, 2, 3]) assert.equal((await c.ctl(i, "/ctl/audit")).body.ok, true);
    await c.assertNoConflictingFinality();
    console.log(`[bft-crash-points] seed=${SEED} ${JSON.stringify(results)}`);
    assert.ok(results.some(r => (r.repairedTornBytes as number) > 0), "a torn line was repaired at least once");
  } catch (e) {
    for (const [i, l] of c.logs) console.error(`--- v${i} log tail ---\n${l.slice(-2500)}`);
    throw e;
  } finally {
    c.close();
  }
});
