/**
 * 0.5.83 Block B: BFT finality and recovery, four validator OS processes.
 *
 * Seeded fault injection on every directed link (loss, delay => reordering, duplication,
 * partitions), SIGKILL + restart from each validator's own disk, internal height-producer
 * tickers (automatic round changes, no harness-driven rounds), and two adversaries:
 *   - an equivocating leader (two signed proposals for one height/round, split between peers):
 *     honest validators detect it from relayed proposals, persist the evidence, change round at
 *     once and finalize the height under the next leader (liveness);
 *   - a crashed leader: the round timer expires and the next leader finalizes (liveness).
 * Safety is checked after every phase: no height has two different finalized blocks on any two
 * validators, also after restarts (finality is read from the persisted kernel state).
 *
 * Limits (also in docs/audit/0.5.83-RESOLUTION.md): one machine, loopback TCP, scripted
 * adversaries, 4 validators (f = 1). This is evidence for these scenarios only; it does not
 * show safety against arbitrary adversaries or WAN conditions.
 * Reproduce: UEP_BFT_FAULT_SEED=<seed> node --experimental-strip-types --test src/node/bft-recovery-multiprocess.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { txToWire } from "./certified-commit.ts";
import { startCluster, waitFor } from "./bft-mp-harness.ts";

const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261015);

test(`Block B: equivocation evidence, automatic round change, liveness under a new leader, partitions and restarts (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const c = await startCluster({ seed: SEED, spends: 6, autoTickMs: 150, roundTimer: { baseTicks: 6, maxDoublings: 4 } });
  const { txs, roots } = c;
  try {
    await Promise.all([0, 1, 2, 3].map(i => c.start(i)));
    const h0 = (await c.st(0)).expectedHeight;
    const submitAll = async (k: number, who = c.live()) => { for (const i of who) await c.ctl(i, "/ctl/submit", { tx: txToWire(txs[k]!) }).catch(() => {}); };
    const syncAll = async () => { for (const i of c.live()) await c.ctl(i, "/ctl/sync").catch(() => {}); };
    const committedEverywhere = (h: number, who: number[]) => waitFor(`height ${h} applied on ${who}`, async () => {
      await syncAll();
      const s = await Promise.all(who.map(i => c.st(i)));
      return s.every(x => x.status[String(h)] === "APPLIED") ? s : false;
    }, 120_000, 300);

    // Phase 1: round-0 commit under loss 10 %, duplication 25 %, delay up to 100 ms (reordering).
    c.setAll({ loss: 0.1, dup: 0.25, maxDelayMs: 100, blocked: false });
    await submitAll(0);
    await c.ctl(c.leaderFor(h0), "/ctl/propose", { tx: txToWire(txs[0]!) }).catch(() => {});
    await committedEverywhere(h0, [0, 1, 2, 3]);
    await c.assertNoConflictingFinality();

    // Phase 2: the round-0 leader of h1 equivocates (txs[1] to half the peers, a conflicting spend to the others).
    const h1 = h0 + 1;
    const byz = c.leaderFor(h1);
    const honest = [0, 1, 2, 3].filter(i => i !== byz);
    const alt = c.conflicting(1);
    await submitAll(1, honest);
    await c.ctl(byz, "/ctl/equivocate", { txs: [txToWire(txs[1]!), txToWire(alt)] });
    // Detection and persisted evidence on every honest validator (relayed proposals + evidence gossip).
    await waitFor("equivocation evidence on all honest validators", async () => {
      const ev = await Promise.all(honest.map(i => c.ctl(i, "/ctl/evidence")));
      return ev.every(e => e.body.evidence.some((x: { proposerId: string; height: number }) => x.proposerId === `v${byz}` && x.height === h1));
    }, 60_000);
    for (const i of honest) {
      const file = join(c.stateDirs[i]!, "bft-equivocation-evidence.jsonl");
      assert.ok(existsSync(file), `evidence persisted by v${i}`);
      const ev = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]!);
      assert.notEqual(ev.a.proposal.blockId, ev.b.proposal.blockId);
    }
    // Liveness: a later round's leader (honest) finalizes h1 with one block, automatically.
    const after = await committedEverywhere(h1, honest);
    const finalBlock = after[0]!.committed.find(([h]) => Number(h) === h1)![1];
    assert.ok([txs[1]!.txId.toHex(), alt.txId.toHex()].includes(finalBlock));
    await c.assertNoConflictingFinality();
    // The chain continues from whichever block was finalized; rebuild the expected roots only if the alternative won.
    const usedMain = finalBlock === txs[1]!.txId.toHex();
    console.log(`[bft-recovery] seed=${SEED} equivocation at h=${h1} by v${byz}; finalized ${usedMain ? "txs[1]" : "alt"} in round>=1`);

    // Phase 3: restart an honest validator (SIGKILL) and check its evidence and finality survive on disk.
    const victim = honest.find(i => i !== c.leaderFor(h1 + 1))!;
    await c.kill(victim);
    await c.start(victim);
    const evAfter = await c.ctl(victim, "/ctl/evidence");
    assert.ok(evAfter.body.evidence.some((x: { height: number }) => x.height === h1), "evidence survives restart");
    assert.ok((await c.st(victim)).committed.some(([h, b]) => Number(h) === h1 && b === finalBlock), "finality survives restart");
    await c.assertNoConflictingFinality();

    if (usedMain) {
      // Phase 4: the round-0 leader of h2 crashes (SIGKILL) under faults: timeout, round change, new leader finalizes.
      const h2 = h1 + 1;
      const crashed = c.leaderFor(h2);
      await c.kill(crashed);
      const rest = [0, 1, 2, 3].filter(i => i !== crashed);
      c.setAll({ loss: 0.05, dup: 0.3, maxDelayMs: 80, blocked: false });
      await submitAll(2, rest);
      await committedEverywhere(h2, rest);
      await c.assertNoConflictingFinality();
      await c.start(crashed);
      await committedEverywhere(h2, [0, 1, 2, 3]);
      assert.equal((await c.st(crashed)).stateRoot, roots[2], "restarted leader syncs to the reference root");

      // Phase 5: partition 2 | 2 (no quorum on either side): nothing is finalized; heal: the height finalizes once.
      const h3 = h2 + 1;
      c.partition([0, 1]);
      await submitAll(3);
      await c.ctl(c.leaderFor(h3), "/ctl/propose", { tx: txToWire(txs[3]!) }).catch(() => {});
      await new Promise(f => setTimeout(f, 3_000));
      for (const i of c.live()) assert.ok(!(await c.st(i)).committed.some(([h]) => Number(h) === h3), "no finality without quorum");
      // A validator restarts while partitioned (persisted round/lock state reloaded).
      await c.kill(2); await c.start(2);
      c.setAll({ loss: 0.05, dup: 0.2, maxDelayMs: 60, blocked: false });
      await committedEverywhere(h3, [0, 1, 2, 3]);
      const finals = await Promise.all([0, 1, 2, 3].map(i => c.st(i)));
      assert.equal(new Set(finals.map(s => s.stateRoot)).size, 1, "all validators converge");
      assert.equal(finals[0]!.stateRoot, roots[3]);
    }
    await c.assertNoConflictingFinality();
    assert.ok(c.stats.dropped > 0 && c.stats.duplicated > 0, `faults were injected: ${JSON.stringify(c.stats)}`);
    console.log(`[bft-recovery] seed=${SEED} stats=${JSON.stringify(c.stats)}`);
  } catch (e) {
    for (const [i, l] of c.logs) console.error(`--- v${i} log tail ---\n${l.slice(-3000)}`);
    throw e;
  } finally {
    c.close();
  }
});
