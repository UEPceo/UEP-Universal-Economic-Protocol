/**
 * Three real `cli.ts` processes, one data dir each, each with its own keys.
 * What the in-process harness cannot show: a node that starts late catches up from a peer snapshot
 * signed by the peer's own key, only if the peer list pins that key; and the node then serves the ledger it kept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientBlinding } from "../core/client-note.ts";
import { publicKeyHexOf } from "../core/ed25519.ts";
import { serializeTx } from "../core/transaction.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { newNodeLedger } from "./assemble.ts";

const ASSET = "uep-test/teur";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;

function pem() {
  const pair = generateKeyPairSync("ed25519");
  return { pair, pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyHex: publicKeyHexOf(pair.publicKey) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function start(index: number, dir: string, peersFile: string, peerPort: number, apiPort: number, children: ChildProcess[]): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/node/cli.ts"], {
    cwd: ROOT,
    env: { ...process.env, UEP_PEERS: peersFile, UEP_NODE_ID: `node-${index}`, UEP_DATA_DIR: dir, UEP_PORT: String(apiPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`node-${index} did not start: ${out} ${err}`)), 90_000);
    child.stdout!.on("data", (chunk) => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.startsWith("uep-peer "));
      if (line) { clearTimeout(timer); resolve({ child, line }); }
    });
    child.stderr!.on("data", (chunk) => { err += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`node-${index} exited ${code}: ${out} ${err}`)); });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

const status = async (port: number) => await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { height: number; stateRoot: string; txCount: number };

test("a node started late catches up from a peer snapshot only when the peer list pins the cluster keys", { timeout: 300_000 }, async () => {
  const children: ChildProcess[] = [];
  const base = mkdtempSync(join(tmpdir(), "uep-cluster-"));
  try {
    const keys = [0, 1, 2].map(() => ({ voter: pem(), snapshot: pem(), faucet: pem() }));
    const dirs = [0, 1, 2].map((i) => join(base, `node-${i}`));
    dirs.forEach((dir, i) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "voter.pem"), keys[i]!.voter.pem, { mode: 0o600 });
      writeFileSync(join(dir, "snapshot.pem"), keys[i]!.snapshot.pem, { mode: 0o600 });
      writeFileSync(join(dir, "faucet.pem"), keys[i]!.faucet.pem, { mode: 0o600 });
    });
    const peerPorts = await Promise.all([0, 1, 2].map(freePort));
    const apiPorts = await Promise.all([0, 1, 2].map(freePort));
    const entry = (i: number, pinned: boolean) => ({
      id: `node-${i}`,
      url: `http://127.0.0.1:${peerPorts[i]}`,
      publicKeyHex: keys[i]!.voter.publicKeyHex,
      ...(pinned ? { snapshotPublicKeyHex: keys[i]!.snapshot.publicKeyHex, faucetPublicKeyHex: keys[i]!.faucet.publicKeyHex } : {}),
    });
    const pinnedFile = join(base, "peers-pinned.json");
    const unpinnedFile = join(base, "peers-unpinned.json");
    writeFileSync(pinnedFile, JSON.stringify({ threshold: 2, peers: [0, 1, 2].map((i) => entry(i, true)) }));
    writeFileSync(unpinnedFile, JSON.stringify({ threshold: 2, peers: [0, 1, 2].map((i) => entry(i, false)) }));

    // Shared genesis for node-0 and node-1: one mint, signed by node-0's faucet key and snapshot key.
    const custody = await identityFromMnemonic(await generateMnemonic(128));
    const buyer = await identityFromMnemonic(await generateMnemonic(128));
    const asKeys = (k: ReturnType<typeof pem>) => ({ privateKey: k.pair.privateKey, publicKey: k.pair.publicKey, publicKeyHex: k.publicKeyHex });
    const seed = newNodeLedger({ snapshotKey: asKeys(keys[0]!.snapshot), faucetKey: asKeys(keys[0]!.faucet), noteBlindingDomain: 7n });
    seed.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
    const genesis = JSON.stringify(seed.snapshot(), encode);
    for (const i of [0, 1]) writeFileSync(join(dirs[i]!, "ledger.snapshot.json"), genesis, { mode: 0o600 });

    const first = await Promise.all([0, 1].map((i) => start(i, dirs[i]!, pinnedFile, peerPorts[i]!, apiPorts[i]!, children)));
    assert.match(first[0]!.line, /snapshotPublicKeyHex=/);
    assert.match(first[0]!.line, /faucetPublicKeyHex=/);

    // A client builds the spend against the genesis state and hands it to node-0. node-1 is the second vote; node-2 is down.
    const height = (await status(peerPorts[0]!)).height;
    const built = seed.preparePayment(buyer, custody.accountId, ASSET, 1_000n, height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const proposed = await fetch(`http://127.0.0.1:${peerPorts[0]}/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: serializeTx(built.txs[0]!) }, encode) });
    const result = await proposed.json() as { stateRoot: string; votes: number; error?: string };
    assert.equal(proposed.status, 200, JSON.stringify(result));
    assert.equal(result.votes >= 2, true);
    assert.equal((await status(peerPorts[1]!)).stateRoot, result.stateRoot);

    // node-2 starts empty and the peer list does NOT pin the cluster keys: the peer snapshot carries no weight.
    const unpinned = await start(2, dirs[2]!, unpinnedFile, peerPorts[2]!, apiPorts[2]!, children);
    assert.match(unpinned.line, /caughtUp=false/);
    assert.notEqual((await status(peerPorts[2]!)).stateRoot, result.stateRoot);
    await stop(unpinned.child);

    // Same node, same data dir, with the keys pinned: it restores the peer snapshot and serves that ledger.
    const pinned = await start(2, dirs[2]!, pinnedFile, peerPorts[2]!, apiPorts[2]!, children);
    assert.match(pinned.line, /caughtUp=true/);
    assert.equal((await status(peerPorts[2]!)).stateRoot, result.stateRoot);
    const tip = await (await fetch(`http://127.0.0.1:${apiPorts[2]}/v1/economic/tip`)).json() as { data: { stateRoot: string } };
    assert.equal(tip.data.stateRoot, result.stateRoot, "the node API serves the ledger the node kept");
  } finally {
    await Promise.all(children.map(stop));
    rmSync(base, { recursive: true, force: true });
  }
});
