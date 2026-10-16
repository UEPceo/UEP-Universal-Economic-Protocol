/**
 * 0.5.84 item 1: the unified state store in real validator processes (4 processes, one machine).
 *  1. A validator runs the 0.5.83 file layout (UEP_STATE_BACKEND=legacy), commits, is killed with
 *     SIGKILL and restarts on the unified store: the journal and BFT state migrate, audit passes.
 *  2. SIGKILL in the middle of a store frame (half a frame on disk) at the open height: restart
 *     truncates the torn frame, recovery is idempotent across a second kill -9, the cluster continues.
 * Single machine, loopback network: no claim about a real network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { txToWire } from "./certified-commit.ts";
import { startCluster, waitFor } from "./bft-mp-harness.ts";

const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261016);

test(`unified store in validator processes: legacy migration and SIGKILL mid-frame (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const c = await startCluster({ seed: SEED, spends: 4 });
  const { txs, roots } = c;
  const commitAll = async (k: number) => {
    await waitFor(`height ${k} everywhere`, async () => {
      for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/sync").catch(() => {});
      const s = await Promise.all([0, 1, 2, 3].map(i => c.st(i).catch(() => null)));
      return s.every(x => x?.stateRoot === roots[k]);
    }, 60_000);
  };
  try {
    const victim = 1;
    await Promise.all([0, 1, 2, 3].map(i => c.start(i, i === victim ? { UEP_STATE_BACKEND: "legacy" } : {})));
    const h0 = (await c.st(0)).expectedHeight;
    await c.ctl(c.leaderFor(h0), "/ctl/propose", { tx: txToWire(txs[0]!) });
    await commitAll(0);
    assert.ok(existsSync(join(c.stateDirs[victim]!, "bft-commit-log.jsonl")), "victim used the legacy layout");
    await c.kill(victim);
    await c.start(victim); // unified (default): migrates
    const a = (await c.ctl(victim, "/ctl/audit")).body;
    assert.equal(a.ok, true, String(a.problems));
    assert.equal(a.backend, "unified");
    assert.equal(a.stateRoot, roots[0]);
    assert.ok(existsSync(join(c.stateDirs[victim]!, "bft-commit-log.jsonl.migrated")));
    assert.ok(existsSync(join(c.stateDirs[victim]!, "uep-state.wal")));

    // 2. SIGKILL mid-frame at the next open height (the first store frame written there: a vote or the INTENT).
    const h1 = h0 + 1;
    const v2 = [0, 1, 2, 3].find(i => i !== c.leaderFor(h1) && i !== victim)!;
    await c.kill(v2);
    await c.start(v2, { UEP_CRASH_AT: `frame-torn@${h1}` });
    const died = c.exited(v2);
    await c.ctl(c.leaderFor(h1), "/ctl/propose", { tx: txToWire(txs[1]!) }).catch(() => {});
    const exit = await Promise.race([died, new Promise<null>(f => setTimeout(() => f(null), 30_000))]);
    assert.ok(exit && exit.signal === "SIGKILL", `v${v2} killed mid-frame (got ${JSON.stringify(exit)})`);
    await c.assertNoConflictingFinality();
    await c.start(v2);
    const b1 = (await c.ctl(v2, "/ctl/audit")).body;
    assert.equal(b1.ok, true, String(b1.problems));
    assert.ok(b1.repairedTornBytes > 0, "torn frame truncated at open");
    await c.ctl(v2, "/ctl/sync");
    const b1s = (await c.ctl(v2, "/ctl/audit")).body;
    assert.equal(b1s.stateRoot, roots[1]);
    await c.kill(v2);
    await c.start(v2);
    const b2 = (await c.ctl(v2, "/ctl/audit")).body;
    for (const f of ["head", "entries", "stateRoot", "txCount"] as const) assert.equal(b2[f], b1s[f], `idempotent recovery: ${f}`);

    // 3. the cluster continues with every validator
    await c.ctl(c.leaderFor(h0 + 2), "/ctl/propose", { tx: txToWire(txs[2]!) });
    await commitAll(2);
    for (const i of [0, 1, 2, 3]) assert.equal((await c.ctl(i, "/ctl/audit")).body.ok, true);
    await c.assertNoConflictingFinality();
    console.log(`[bft-unified-store] seed=${SEED} migrated=v${victim} tornVictim=v${v2} repairedTornBytes=${b1.repairedTornBytes} head=${b2.head}`);
  } catch (e) {
    for (const [i, l] of c.logs) console.error(`--- v${i} log tail ---\n${l.slice(-2500)}`);
    throw e;
  } finally {
    c.close();
  }
});
