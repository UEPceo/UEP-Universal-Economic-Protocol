/**
 * 0.5.83 test harness (Blocks B and C): N BFT validators in N separate OS processes,
 * one seeded fault-injecting proxy per directed link (loss, delay => reordering,
 * duplication, partition), SIGKILL and restart from each validator's own state
 * directory. Test-only: keys are throwaway, generated per run in a temp dir and
 * deleted afterwards (never persisted, never committed).
 */
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

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ASSET = "uep-test/teur";
export const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;
export function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; }; }
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createNetServer(); s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
export type Link = { loss: number; dup: number; maxDelayMs: number; blocked: boolean };
export const calm: Link = { loss: 0, dup: 0, maxDelayMs: 0, blocked: false };
export const alive = (c?: ChildProcess) => !!c && c.exitCode === null && c.signalCode === null;
export type Stats = { dropped: number; duplicated: number; forwarded: number };

function linkProxy(targetPort: () => number, link: () => Link, r: () => number, stats: Stats): Server {
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

export type St = { stateRoot: string; committed: [string, string][]; status: Record<string, string>; expectedHeight: number; txCount: number;
  /** 0.5.84 store continuity: "ok" or the reason signing is suspended; store seq; peer attestation check. */
  signing: string; storeSeq: number | null; peerCheck: { responses: number; stale: boolean; maxSeen: number; done: boolean } };

export type ClusterOptions = { n?: number; seed: number; spends?: number; autoTickMs?: number; roundTimer?: { baseTicks: number; maxDoublings: number }; extraConfig?: Record<string, unknown>; env?: Record<string, string> };

/** Build genesis + `spends` sequential payments on a reference ledger, start N validator processes behind link proxies. */
export async function startCluster(o: ClusterOptions) {
  const n = o.n ?? 4;
  const base = mkdtempSync(join(tmpdir(), "uep-bft-0583-"));
  const children = new Map<number, ChildProcess>();
  const logs = new Map<number, string>();
  const proxies: Server[] = [];
  const stats: Stats = { dropped: 0, duplicated: 0, forwarded: 0 };
  const links = new Map<string, Link>();
  const setAll = (l: Link) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) links.set(`${i}>${j}`, { ...l }); };
  const partition = (side: number[]) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) links.get(`${i}>${j}`)!.blocked = side.includes(i) !== side.includes(j); };
  setAll(calm);
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seedNode = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 41n });
  seedNode.ledger.faucet(buyer.accountId, ASSET, 500_050n, clientBlinding(3n));
  const genesis = seedNode.ledger.snapshot();
  const genesisFile = join(base, "genesis.json");
  writeFileSync(genesisFile, JSON.stringify(genesis, encode));
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const ref = UepLedger.restore(genesis, trust);
  const spend = (l: UepLedger, amount: bigint, b: bigint) => {
    const built = l.preparePayment(buyer, custody.accountId, ASSET, amount, l.height, { outputBlinding: clientBlinding(b), changeBlinding: clientBlinding(b + 1n) });
    if ("error" in built) throw new Error(built.error.code);
    return built.txs[0]!;
  };
  const txs: UepTransaction[] = [];
  const roots: string[] = [];
  for (let i = 0; i < (o.spends ?? 6); i++) {
    const tx = spend(ref, 100n + BigInt(i), 200n + 2n * BigInt(i));
    txs.push(tx);
    assert.ok(!("error" in ref.submit(tx)));
    roots.push(ref.stateRoot().toHex());
  }
  /** A spend that conflicts with txs[k] (built on the state after txs[0..k-1]). */
  const conflicting = (k: number) => {
    const alt = UepLedger.restore(genesis, trust);
    for (let i = 0; i < k; i++) alt.submit(txs[i]!);
    return spend(alt, 999n + BigInt(k), 900n + 2n * BigInt(k));
  };
  const keys = Array.from({ length: n }, () => { const p = generateKeyPairSync("ed25519"); return { pem: p.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyHex: publicKeyHexOf(p.publicKey) }; });
  const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  const peerPorts: number[] = [];
  const proxyPort = new Map<string, number>();
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) {
    const srv = linkProxy(() => peerPorts[j]!, () => links.get(`${i}>${j}`)!, rng(o.seed + 31 * i + j), stats);
    await new Promise<void>(f => srv.listen(0, "127.0.0.1", () => f()));
    proxies.push(srv); proxyPort.set(`${i}>${j}`, (srv.address() as { port: number }).port);
  }
  const ports: number[] = [];
  while (ports.length < 2 * n) { const p = await freePort(); if (!ports.includes(p) && ![...proxyPort.values()].includes(p)) ports.push(p); }
  peerPorts.push(...ports.slice(0, n));
  const ctlPorts = ports.slice(n);
  const stateDirs: string[] = [];
  const configs = validators.map((_, i) => {
    const dir = join(base, `v${i}`); mkdirSync(dir, { recursive: true });
    stateDirs.push(join(dir, "state"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({
      id: `v${i}`, voterPem: keys[i]!.pem, stateDir: join(dir, "state"), peerPort: peerPorts[i], controlPort: ctlPorts[i],
      validators, faultTolerance: Math.floor((n - 1) / 3), genesisFile, trust,
      // Every peer reaches every other through 127.0.0.1 here, so the per-IP limit (120/min) is raised; it still bounds floods.
      peerRateMax: 1_200,
      ...(o.autoTickMs ? { autoTickMs: o.autoTickMs } : {}), ...(o.roundTimer ? { roundTimer: o.roundTimer } : {}), ...(o.extraConfig ?? {}),
      peers: validators.map((_, j) => j).filter(j => j !== i).map(j => ({ id: `v${j}`, url: `http://127.0.0.1:${proxyPort.get(`${i}>${j}`)}`, publicKeyHex: keys[j]!.publicKeyHex })),
    }), { mode: 0o600 });
    return file;
  });
  // 0.5.84 store continuity: a validator refuses to start without its store, so the very first start
  // of each validator is an explicit genesis start; later starts (restarts) are not.
  const everStarted = new Set<number>();
  const start = (i: number, env: Record<string, string> = {}) => new Promise<void>((resolve, reject) => {
    const initEnv: Record<string, string> = everStarted.has(i) ? {} : { UEP_BFT_STORE_INIT: "genesis" };
    everStarted.add(i);
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/node/bft-validator-process.ts", configs[i]!], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(o.env ?? {}), ...initEnv, ...env } });
    children.set(i, child);
    let out = "";
    const timer = setTimeout(() => reject(new Error(`v${i} did not start: ${logs.get(i)}`)), 60_000);
    const log = (c: Buffer) => { logs.set(i, ((logs.get(i) ?? "") + c).slice(-20_000)); if (process.env.UEP_BFT_DEBUG) process.stderr.write(`[v${i}] ${c}`); };
    child.stdout!.on("data", c => { out += c; log(c); if (out.includes("uep-bft-validator")) { clearTimeout(timer); resolve(); } });
    child.stderr!.on("data", log);
    child.once("exit", (code, sig) => { clearTimeout(timer); reject(new Error(`v${i} exited ${code ?? sig}: ${logs.get(i)}`)); });
  });
  /** Resolves with the exit (code/signal) of a process that is expected to die by itself (crash injection). */
  const exited = (i: number) => new Promise<{ code: number | null; signal: string | null }>(f => {
    const c = children.get(i)!; if (!alive(c)) return f({ code: c.exitCode, signal: c.signalCode });
    c.removeAllListeners("exit"); c.once("exit", (code, signal) => f({ code, signal }));
  });
  const kill = async (i: number) => {
    const c = children.get(i)!; if (!alive(c)) return;
    await new Promise<void>(f => { c.removeAllListeners("exit"); c.once("exit", () => f()); c.kill("SIGKILL"); });
  };
  // 0.5.84 store continuity: a (re)started validator signs nothing until its peer attestation check has
  // 2f answers. Before a proposal, give live validators still in that check up to 10 s (on slow CI runners
  // the first proposal otherwise races the check). Validators that cannot finish it (partitioned) are skipped.
  const settleSigning = async () => {
    const until = Date.now() + 10_000;
    for (;;) {
      const pending = await Promise.all(live().map(async j => {
        try {
          const r = await fetch(`http://127.0.0.1:${ctlPorts[j]}/ctl/state`);
          return ((await r.json()) as St).signing === "BFT_SIGNING_PENDING_PEER_CHECK";
        } catch { return false; }
      }));
      if (!pending.some(Boolean) || Date.now() > until) return;
      await new Promise(f => setTimeout(f, 100));
    }
  };
  const ctl = async (i: number, path: string, body?: unknown) => {
    if (path === "/ctl/propose" || path === "/ctl/equivocate") await settleSigning();
    const res = await fetch(`http://127.0.0.1:${ctlPorts[i]}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, encode) });
    return { status: res.status, body: await res.json() as any };
  };
  const st = async (i: number) => (await ctl(i, "/ctl/state")).body as St;
  const live = () => [...children.entries()].filter(([, c]) => alive(c)).map(([i]) => i);
  /** Safety: across all live validators, each height has at most one finalized block. Returns the union. */
  const assertNoConflictingFinality = async () => {
    const seen = new Map<string, string>();
    for (const i of live()) for (const [h, b] of (await st(i)).committed) {
      const prev = seen.get(h);
      assert.ok(!prev || prev === b, `conflicting finality at height ${h}: ${prev} vs ${b}`);
      seen.set(h, b);
    }
    return seen;
  };
  const leaderFor = (h: number, round = 0) => (h - 1 + round) % n;
  const close = () => {
    for (const c of children.values()) if (alive(c)) c.kill("SIGKILL");
    for (const p of proxies) p.close();
    if (!process.env.UEP_BFT_KEEP) rmSync(base, { recursive: true, force: true });
  };
  return { n, base, txs, roots, conflicting, validators, stateDirs, stats, links, setAll, partition, start, kill, exited, ctl, st, live, assertNoConflictingFinality, leaderFor, close, logs, children };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 60_000, everyMs = 200): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await new Promise(f => setTimeout(f, everyMs));
  }
  throw new Error(`timeout waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}
