/**
 * Item 3 (0.5.81): four BFT validators in four OS processes, each with its own key and state
 * directory, talking through a seeded fault-injecting proxy per directed link (loss, delay and
 * therefore reordering, duplication, partition). Scenario: commits under faults, a SIGKILL'd
 * validator restarting from its own disk, a partition with no quorum on either side, a proposal
 * of an already-spent transaction, and an equivocating proposer.
 *
 * What it shows: no two honest validators finalize different blocks at a height, and after the
 * network heals and lagging validators sync, honest validators converge on the same root.
 * What it does not show: liveness after an equivocating proposer (no automatic round-change
 * timer yet), behaviour across machines or real WAN conditions, or anything about adversaries
 * beyond these scripted ones. Seed is in the test name; set UEP_BFT_FAULT_SEED to reproduce.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair, publicKeyHexOf } from "../core/ed25519.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { txToWire } from "./certified-commit.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASSET = "uep-test/teur";
const SEED = Number(process.env.UEP_BFT_FAULT_SEED ?? 20261015);
const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;

function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; }; }
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createNetServer(); s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

type Link = { loss: number; dup: number; maxDelayMs: number; blocked: boolean };
const alive = (c?: ChildProcess) => !!c && c.exitCode === null && c.signalCode === null;
const calm: Link = { loss: 0, dup: 0, maxDelayMs: 0, blocked: false };

/** One proxy per directed link src→dst. Drops by destroying the socket (the sender sees a network error). */
function linkProxy(targetPort: () => number, link: () => Link, r: () => number, stats: { dropped: number; duplicated: number; forwarded: number }): Server {
  return createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const l = link();
      if (l.blocked || r() < l.loss) { stats.dropped++; req.socket.destroy(); return; }
      await new Promise(f => setTimeout(f, Math.floor(r() * l.maxDelayMs)));
      const init = { method: req.method, headers: { "content-type": "application/json" }, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) };
      const url = `http://127.0.0.1:${targetPort()}${req.url}`;
      try {
        if (r() < l.dup) { stats.duplicated++; void fetch(url, init).catch(() => {}); }
        const out = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
        stats.forwarded++;
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch { req.socket.destroy(); }
    });
  });
}

test(`item 3: four validator processes under loss/delay/duplication, restart, partition and a byzantine proposer (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const r = rng(SEED);
  const base = mkdtempSync(join(tmpdir(), "uep-bft-mp-"));
  const children = new Map<number, ChildProcess>();
  const proxies: Server[] = [];
  const stats = { dropped: 0, duplicated: 0, forwarded: 0 };
  const links = new Map<string, Link>();
  const setAll = (l: Link) => { for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) links.set(`${i}>${j}`, { ...l }); };
  setAll(calm);
  try {
    // Ledger genesis (one funded buyer) and six sequential spends built on a reference ledger.
    const snapshotKey = generateEd25519KeyPair();
    const faucetKey = generateEd25519KeyPair();
    const custody = await identityFromMnemonic(await generateMnemonic(128));
    const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
    const buyer = await identityFromMnemonic(await generateMnemonic(128));
    const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 41n });
    seed.ledger.faucet(buyer.accountId, ASSET, 50_050n, clientBlinding(3n));
    const genesis = seed.ledger.snapshot();
    const genesisFile = join(base, "genesis.json");
    writeFileSync(genesisFile, JSON.stringify(genesis, encode));
    const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
    const ref = UepLedger.restore(genesis, trust);
    const txs: UepTransaction[] = [];
    const roots: string[] = [];
    const spend = (l: UepLedger, amount: bigint, b: bigint) => {
      const built = l.preparePayment(buyer, custody.accountId, ASSET, amount, l.height, { outputBlinding: clientBlinding(b), changeBlinding: clientBlinding(b + 1n) });
      if ("error" in built) throw new Error(built.error.code);
      return built.txs[0]!;
    };
    for (let i = 0; i < 6; i++) {
      const tx = spend(ref, 100n + BigInt(i), 200n + 2n * BigInt(i));
      txs.push(tx);
      assert.ok(!("error" in ref.submit(tx)));
      roots.push(ref.stateRoot().toHex());
    }
    // An alternative spend of the state after tx5 (conflicts with txs[5]) for the equivocation phase.
    const alt = UepLedger.restore(genesis, trust);
    for (let i = 0; i < 5; i++) alt.submit(txs[i]!);
    const altTx6 = spend(alt, 999n, 900n);

    // Four validators, own keys and directories, proxies on every directed link.
    const keys = [0, 1, 2, 3].map(() => { const p = generateKeyPairSync("ed25519"); return { pem: p.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyHex: publicKeyHexOf(p.publicKey) }; });
    const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
    // Proxies bind first (port 0); validator ports are reserved afterwards so they cannot collide.
    const peerPorts: number[] = [];
    const proxyPort = new Map<string, number>();
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) {
      const linkRng = rng(SEED + 31 * i + j);
      const srv = linkProxy(() => peerPorts[j]!, () => links.get(`${i}>${j}`)!, linkRng, stats);
      await new Promise<void>(f => srv.listen(0, "127.0.0.1", () => f()));
      proxies.push(srv); proxyPort.set(`${i}>${j}`, (srv.address() as { port: number }).port);
    }
    const ports: number[] = [];
    while (ports.length < 8) { const p = await freePort(); if (!ports.includes(p) && ![...proxyPort.values()].includes(p)) ports.push(p); }
    peerPorts.push(...ports.slice(0, 4));
    const ctlPorts = ports.slice(4);
    const configs = [0, 1, 2, 3].map(i => {
      const dir = join(base, `v${i}`); mkdirSync(dir, { recursive: true });
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify({
        id: `v${i}`, voterPem: keys[i]!.pem, stateDir: join(dir, "state"), peerPort: peerPorts[i], controlPort: ctlPorts[i],
        validators, faultTolerance: 1, genesisFile, trust,
        peers: [0, 1, 2, 3].filter(j => j !== i).map(j => ({ id: `v${j}`, url: `http://127.0.0.1:${proxyPort.get(`${i}>${j}`)}`, publicKeyHex: keys[j]!.publicKeyHex })),
      }), { mode: 0o600 });
      return file;
    });
    const start = (i: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/node/bft-validator-process.ts", configs[i]!], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      children.set(i, child);
      let out = "", err = "";
      const timer = setTimeout(() => reject(new Error(`v${i} did not start: ${out} ${err}`)), 60_000);
      child.stdout!.on("data", c => { out += c; if (process.env.UEP_BFT_DEBUG) process.stderr.write(`[v${i} out] ${c}`); if (out.includes("uep-bft-validator")) { clearTimeout(timer); resolve(); } });
      child.stderr!.on("data", c => { err += c; if (process.env.UEP_BFT_DEBUG) process.stderr.write(`[v${i}] ${c}`); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`v${i} exited ${code}: ${err}`)); });
    });
    const kill = async (i: number) => {
      const c = children.get(i)!; if (!alive(c)) return;
      await new Promise<void>(f => { c.removeAllListeners("exit"); c.once("exit", () => f()); c.kill("SIGKILL"); });
    };
    const ctl = async (i: number, path: string, body?: unknown) => {
      if (process.env.UEP_BFT_DEBUG) console.error(`ctl v${i} ${path}`);
      const res = await fetch(`http://127.0.0.1:${ctlPorts[i]}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, encode) })
        .catch((e: Error) => { throw new Error(`control v${i} ${path} port=${ctlPorts[i]} (alive=${alive(children.get(i))}): ${e.message} ${(e as { cause?: Error }).cause?.message}`); });
      return { status: res.status, body: await res.json() as any };
    };
    type St = { stateRoot: string; committed: [string, string][]; status: Record<string, string>; expectedHeight: number };
    const st = async (i: number) => (await ctl(i, "/ctl/state")).body as St;
    const live = () => [...children.entries()].filter(([, c]) => alive(c)).map(([i]) => i);

    /** Safety: no height is finalized with two different blocks by any two live validators. */
    const assertNoConflictingFinality = async () => {
      const seen = new Map<string, string>();
      for (const i of live()) for (const [h, b] of (await st(i)).committed) {
        const prev = seen.get(h);
        assert.ok(!prev || prev === b, `conflicting finality at height ${h}: ${prev} vs ${b}`);
        seen.set(h, b);
      }
    };
    const leaderFor = (h: number) => (h - 1) % 4; // validators v0..v3 sorted; round 0
    const commit = async (k: number) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const leader = leaderFor((await st(live()[0]!)).expectedHeight);
        await ctl(leader, "/ctl/propose", { tx: txToWire(txs[k]!) });
        await assertNoConflictingFinality();
        for (const i of live()) await ctl(i, "/ctl/sync");
        if ((await st(leader)).stateRoot === roots[k]) return;
      }
      assert.fail(`height for tx ${k} did not commit`);
    };

    await Promise.all([0, 1, 2, 3].map(start));
    const h0 = (await st(0)).expectedHeight;
    assert.deepEqual([0, 1, 2, 3].map(leaderFor.bind(null, h0)).length, 4);

    // Phase 1: loss 15 %, duplication 20 %, delay up to 120 ms (so messages reorder).
    setAll({ loss: 0.15, dup: 0.2, maxDelayMs: 120, blocked: false });
    await commit(0);
    await commit(1);

    // Phase 2: SIGKILL a non-leader of the next two heights, commit without it, restart it from its own disk, sync.
    const victim = [0, 1, 2, 3].find(i => i !== leaderFor(h0 + 2) && i !== leaderFor(h0 + 3))!;
    await kill(victim);
    await commit(2);
    await commit(3);
    await start(victim);
    await ctl(victim, "/ctl/sync");
    assert.equal((await st(victim)).stateRoot, roots[3], "restarted validator recovers its log and syncs");

    // Phase 3: a malicious proposal of an already-spent transaction gets no honest vote.
    setAll(calm);
    const h4 = (await st(0)).expectedHeight;
    const evil = await ctl(leaderFor(h4), "/ctl/equivocate", { txs: [txToWire(txs[0]!), txToWire(txs[1]!)] });
    assert.ok(evil.body.out.every((o: { vote: boolean }) => !o.vote), "no vote for a spent transaction");
    await assertNoConflictingFinality();

    // Phase 4: partition {a,b} | {c,d}: no side has the 3-of-4 quorum; nothing new is finalized.
    const sides = [[0, 1], [2, 3]];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) links.get(`${i}>${j}`)!.blocked = sides[0]!.includes(i) !== sides[0]!.includes(j);
    const before = await Promise.all(live().map(st));
    await ctl(leaderFor(h4), "/ctl/propose", { tx: txToWire(txs[4]!) });
    const after = await Promise.all(live().map(st));
    assert.deepEqual(after.map(s => s.stateRoot), before.map(s => s.stateRoot), "no state change without quorum");
    assert.ok(after.every(s => !s.committed.some(([h]) => Number(h) === h4)), "no finality without quorum");
    // Heal and commit the same height (votes are idempotent for the same proposal core).
    setAll({ loss: 0.1, dup: 0.1, maxDelayMs: 80, blocked: false });
    await commit(4);

    // Phase 5: the next leader equivocates (txs[5] to half the peers, a conflicting spend to the other half).
    setAll(calm);
    const h5 = (await st(0)).expectedHeight;
    const byz = leaderFor(h5);
    await ctl(byz, "/ctl/equivocate", { txs: [txToWire(txs[5]!), txToWire(altTx6)] });
    await assertNoConflictingFinality();
    const honest = live().filter(i => i !== byz);
    for (const i of honest) await ctl(i, "/ctl/sync");

    // Convergence of honest validators on the last common height, and the reference root.
    const finals = await Promise.all(honest.map(st));
    assert.equal(new Set(finals.map(s => s.stateRoot)).size, 1, "honest validators converge");
    assert.equal(finals[0]!.stateRoot, roots[4]);
    for (const s of finals) {
      for (let k = 0; k < 5; k++) assert.equal(s.status[String(h0 + k)], "APPLIED");
      assert.ok(!s.committed.some(([h]) => Number(h) === h5), "no finality at the equivocated height");
    }
    assert.ok(stats.dropped > 0 && stats.duplicated > 0, `faults were injected: ${JSON.stringify(stats)}`);
    console.log(`[bft-multiprocess] seed=${SEED} ${JSON.stringify(stats)}`);
  } finally {
    for (const c of children.values()) if (alive(c)) c.kill("SIGKILL");
    for (const p of proxies) p.close();
    rmSync(base, { recursive: true, force: true });
  }
});
