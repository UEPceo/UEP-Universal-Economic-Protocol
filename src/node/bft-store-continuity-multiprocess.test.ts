/**
 * 0.5.84 BFT store continuity checks, 4 validator OS processes (one machine, loopback proxies).
 *
 * Replays the 4-process recovery scenario (1 Byzantine validator, f = 1): after a height is decided on
 * {byz, r, h0}, the stores of byz and r are deleted or replaced by an older valid copy, h0 is isolated, and a
 * conflicting block is offered to {byz, r, h1}. The Byzantine validator runs with the test-only switch
 * UEP_TEST_BYZANTINE_STATELESS=1 (it signs from whatever state it has); r is honest.
 *   control  : stores intact -> no conflicting finality, r restarts and signs again.
 *   delete   : r refuses to start (BFT_STORE_MISSING); with UEP_BFT_REJOIN=retire it starts watch-only;
 *              no conflicting finality.
 *   rollback : r refuses to start (BFT_STORE_STALE, anchor); no conflicting finality.
 *   peer check (separate cluster): r's store AND anchor are rolled back while peers saw newer attestations;
 *              r starts but keeps signing suspended (BFT_STORE_STALE).
 * Single machine, scripted adversary: regression evidence for the implementation, not a network-level claim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { txToWire } from "./certified-commit.ts";
import { startCluster, waitFor } from "./bft-mp-harness.ts";
import { defaultAnchorPath } from "./bft-store-continuity.ts";

const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261016);
const FILES = ["uep-state.wal", "uep-state.checkpoint"];
const snap = (dir: string, dest: string, withAnchor = false) => {
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(dest, f));
  if (withAnchor && existsSync(defaultAnchorPath(dir))) copyFileSync(defaultAnchorPath(dir), join(dest, "anchor.json"));
};
const wipe = (dir: string) => { for (const f of FILES) if (existsSync(join(dir, f))) unlinkSync(join(dir, f)); };
const restore = (src: string, dir: string, withAnchor = false) => {
  wipe(dir);
  for (const f of FILES) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dir, f));
  if (withAnchor) copyFileSync(join(src, "anchor.json"), defaultAnchorPath(dir));
};

type Mode = "control" | "delete" | "rollback";

async function replay(mode: Mode) {
  const c = await startCluster({ seed: SEED + ["control", "delete", "rollback"].indexOf(mode), spends: 8, autoTickMs: 120, roundTimer: { baseTicks: 4, maxDoublings: 5 } });
  const out: Record<string, unknown> = { mode };
  try {
    await Promise.all([0, 1, 2, 3].map(i => c.start(i)));
    let h = (await c.st(0)).expectedHeight;
    let k = 0;
    while (c.leaderFor(h) !== 2 && k < 6) {
      for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/submit", { tx: txToWire(c.txs[k]!) }).catch(() => {});
      await c.ctl(c.leaderFor(h), "/ctl/propose", { tx: txToWire(c.txs[k]!) }).catch(() => {});
      const hh = h;
      await waitFor(`warmup ${hh}`, async () => {
        for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/sync").catch(() => {});
        const s = await Promise.all([0, 1, 2, 3].map(i => c.st(i)));
        return s.every(x => x.status[String(hh)] === "APPLIED");
      }, 90_000, 300);
      k++; h = (await c.st(0)).expectedHeight;
    }
    assert.equal(c.leaderFor(h), 2, "leader alignment");
    const BYZ = 0, R = 1, H0 = 2, H1 = 3;
    const oldR = join(c.base, "old-r"), oldByz = join(c.base, "old-byz");
    snap(c.stateDirs[R]!, oldR); snap(c.stateDirs[BYZ]!, oldByz);
    await c.kill(BYZ); await c.kill(R);
    await c.start(BYZ, { UEP_CRASH_AT: `before-intent@${h}` });
    await c.start(R, { UEP_CRASH_AT: `before-intent@${h}` });
    c.partition([BYZ, R, H0]);
    const x = c.txs[k]!, y = c.conflicting(k);
    for (const i of [BYZ, R, H0]) await c.ctl(i, "/ctl/submit", { tx: txToWire(x) }).catch(() => {});
    const diedByz = c.exited(BYZ), diedR = c.exited(R);
    await c.ctl(H0, "/ctl/propose", { tx: txToWire(x) }).catch(() => {});
    await waitFor("H0 applied X", async () => { await c.ctl(H0, "/ctl/sync").catch(() => {}); return (await c.st(H0)).status[String(h)] === "APPLIED"; }, 90_000, 300);
    await Promise.race([Promise.all([diedByz, diedR]), new Promise(f => setTimeout(f, 45_000))]);
    if (mode === "delete") { wipe(c.stateDirs[R]!); wipe(c.stateDirs[BYZ]!); }
    if (mode === "rollback") { restore(oldR, c.stateDirs[R]!); restore(oldByz, c.stateDirs[BYZ]!); }
    // Byzantine validator: test-only stateless mode in the attack modes. Honest r: normal start.
    await c.start(BYZ, mode === "control" ? {} : { UEP_TEST_BYZANTINE_STATELESS: "1" });
    out.rStart = await c.start(R).then(() => "started", (e: Error) => (e.message.match(/BFT_STORE_[A-Z_]+/) ?? [e.message.slice(0, 120)])[0]);
    if (mode === "delete") {
      // Explicit re-key/rejoin path: the identity comes back watch-only.
      out.rRejoin = await c.start(R, { UEP_BFT_REJOIN: "retire" }).then(() => "started", (e: Error) => e.message.slice(0, 160));
      if (out.rRejoin === "started") out.rSigning = (await c.st(R)).signing;
    }
    c.partition([BYZ, R, H1]);
    for (const i of [BYZ, R, H1]) await c.ctl(i, "/ctl/submit", { tx: txToWire(y) }).catch(() => {});
    out.yLanded = await waitFor("Y on {byz,r,h1}", async () => {
      for (const i of [BYZ, R, H1]) { await c.ctl(i, "/ctl/tick").catch(() => {}); await c.ctl(i, "/ctl/sync").catch(() => {}); }
      const s = await Promise.all([BYZ, R, H1].map(i => c.st(i).catch(() => null)));
      return s.some(v => v?.committed.some(([hh, b]) => Number(hh) === h && b === y.txId.toHex())) || false;
    }, mode === "control" ? 30_000 : 45_000, 400).then(() => true, () => false);
    if (mode === "control") out.rSigning = (await c.st(R)).signing;
    out.conflict = await c.assertNoConflictingFinality().then(() => false, () => true);
    return out;
  } finally { c.close(); }
}

for (const mode of ["control", "delete", "rollback"] as const) {
  test(`store continuity replay (${mode}): no conflicting finality (seed ${SEED})`, { timeout: 600_000 }, async () => {
    const r = await replay(mode);
    console.log(`[continuity-mp] ${JSON.stringify(r)}`);
    assert.equal(r.conflict, false, "no two finalized blocks at one height");
    assert.equal(r.yLanded, false);
    if (mode === "control") { assert.equal(r.rStart, "started"); assert.equal(r.rSigning, "ok"); }
    if (mode === "delete") { assert.equal(r.rStart, "BFT_STORE_MISSING"); assert.equal(r.rRejoin, "started"); assert.equal(r.rSigning, "BFT_IDENTITY_RETIRED"); }
    if (mode === "rollback") assert.equal(r.rStart, "BFT_STORE_STALE");
  });
}

test(`store continuity: store and anchor both rolled back -> peer attestations keep signing suspended (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const c = await startCluster({ seed: SEED + 7, spends: 4 });
  try {
    await Promise.all([0, 1, 2, 3].map(i => c.start(i)));
    const R = 1;
    await waitFor("r peer check", async () => (await c.st(R)).signing === "ok", 30_000, 200);
    const old = join(c.base, "old-r-all");
    snap(c.stateDirs[R]!, old, true);
    const seqOld = (await c.st(R)).storeSeq as number;
    for (let k = 0; k < 2; k++) {
      const h = (await c.st(0)).expectedHeight;
      await c.ctl(c.leaderFor(h), "/ctl/propose", { tx: txToWire(c.txs[k]!) });
      await waitFor(`h${h} everywhere`, async () => {
        for (const i of [0, 1, 2, 3]) await c.ctl(i, "/ctl/sync").catch(() => {});
        return (await Promise.all([0, 1, 2, 3].map(i => c.st(i)))).every(s => s.status[String(h)] === "APPLIED");
      }, 90_000, 300);
    }
    const seqNew = (await c.st(R)).storeSeq as number;
    assert.ok(seqNew > seqOld);
    await new Promise(f => setTimeout(f, 500)); // attestations are sent asynchronously after each frame
    await c.kill(R);
    restore(old, c.stateDirs[R]!, true); // whole-directory restore, anchor included
    await c.start(R);
    const s = await waitFor("r stale by peers", async () => { const v = await c.st(R); return v.peerCheck.done ? v : false; }, 30_000, 200);
    console.log(`[continuity-mp] peer-check ${JSON.stringify({ seqOld, seqNew, signing: s.signing, peerCheck: s.peerCheck })}`);
    assert.equal(s.signing, "BFT_STORE_STALE");
    assert.ok(s.peerCheck.maxSeen > (s.storeSeq as number));
    await c.assertNoConflictingFinality();
  } finally { c.close(); }
});
