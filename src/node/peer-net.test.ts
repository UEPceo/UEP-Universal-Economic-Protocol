import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { PeerNet, type Peer } from "./peer-net.ts";
import { BftConsensusKernel, type BftValidator } from "./bft-consensus.ts";

const ASSET = "uep-test/teur";

async function three() {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = [0, 1, 2].map(() => generateEd25519KeyPair());
  const voters = new Map(voterKeys.map((key, i) => [`node-${i}`, key.publicKeyHex]));
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fees = await Promise.all([0, 1, 2].map(() => generateMnemonic(128).then(identityFromMnemonic)));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fees[0]!, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nets = voterKeys.map((key, i) => new PeerNet(`node-${i}`, UepLedger.restore(genesis, trust, keys), key.privateKey, key.publicKeyHex, [], voters));
  const ports = await Promise.all(nets.map((net) => net.listen(0)));
  const peers: Peer[] = ports.map((port, i) => ({ id: `node-${i}`, url: `http://127.0.0.1:${port}` }));
  nets.forEach((net, i) => { net.peers = peers.filter((peer) => peer.id !== `node-${i}`); });
  return { nets, peers, buyer, custody, snapshotKey, faucetKey, trust, keys, voterKeys, voters };
}

test("three peers announce height, exchange one spend and confirm with two votes", async () => {
  const { nets, buyer, custody } = await three();
  try {
    const status = await fetch(nets[0]!.server ? `http://127.0.0.1:${(nets[0]!.server!.address() as { port: number }).port}/status` : "");
    assert.equal((await status.json() as { height: number }).height, nets[0]!.ledger.height);
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const result = await nets[0]!.propose(built.txs[0]!);
    assert.equal(result.votes >= 2, true);
    assert.equal(nets[1]!.ledger.stateRoot().toHex(), result.stateRoot);
    assert.equal(nets[2]!.ledger.stateRoot().toHex(), result.stateRoot);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("two live peers confirm, and one alone does not", async () => {
  const { nets, buyer, custody } = await three();
  try {
    await nets[2]!.close();
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const result = await nets[0]!.propose(built.txs[0]!);
    assert.equal(result.votes, 2);
    await nets[1]!.close();
    const other = await identityFromMnemonic(await generateMnemonic(128));
    const second = nets[0]!.ledger.preparePayment(buyer, other.accountId, ASSET, 500n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(21n), changeBlinding: clientBlinding(22n) });
    if ("error" in second) throw new Error(second.error.code);
    await assert.rejects(() => nets[0]!.propose(second.txs[0]!), /QUORUM_NOT_MET/);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a behind node fetches the signed snapshot", async () => {
  const { nets, peers, buyer, custody, trust, keys } = await three();
  try {
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    await nets[0]!.propose(built.txs[0]!);
    const raw = await (await fetch(peers[0]!.url + "/snapshot")).text();
    const snap = JSON.parse(raw, (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v);
    const caught = UepLedger.restore(snap, trust, keys);
    assert.equal(caught.stateRoot().toHex(), nets[0]!.ledger.stateRoot().toHex());
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a dissenting peer cannot confirm a conflicting spend", async () => {
  const { nets, buyer, custody } = await three();
  try {
    const other = await identityFromMnemonic(await generateMnemonic(128));
    const first = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    const second = nets[2]!.ledger.preparePayment(buyer, other.accountId, ASSET, 2_000n, nets[2]!.ledger.height, { outputBlinding: clientBlinding(21n), changeBlinding: clientBlinding(22n) });
    if ("error" in first || "error" in second) throw new Error("PREPARE_FAILED");
    await nets[0]!.propose(first.txs[0]!);
    await assert.rejects(() => nets[2]!.propose(second.txs[0]!), /QUORUM_NOT_MET|DOUBLE_SPEND|QUORUM_EQUIVOCATION/);
    assert.equal(nets[0]!.ledger.stateRoot().toHex(), nets[1]!.ledger.stateRoot().toHex());
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("the peer list is three written addresses and nothing else", async () => {
  const { readFileSync } = await import("node:fs");
  const list = JSON.parse(readFileSync(new URL("../../config/peers.json", import.meta.url), "utf8"));
  assert.equal(list.peers.length, 3);
  assert.equal(list.threshold, 2);
  assert.equal("discovery" in list, false);
});

test("three processes learn voter keys from status and then confirm", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = [0, 1, 2].map(() => generateEd25519KeyPair());
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fees = await Promise.all([0, 1, 2].map(() => generateMnemonic(128).then(identityFromMnemonic)));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fees[0]!, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nets = voterKeys.map((key, i) => new PeerNet(`node-${i}`, UepLedger.restore(genesis, trust, keys), key.privateKey, key.publicKeyHex, [], new Map([[`node-${i}`, key.publicKeyHex]])));
  const ports = await Promise.all(nets.map((net) => net.listen(0)));
  const peers: Peer[] = ports.map((port, i) => ({ id: `node-${i}`, url: `http://127.0.0.1:${port}` }));
  nets.forEach((net, i) => { net.peers = peers.filter((peer) => peer.id !== `node-${i}`); });
  try {
    const known = await Promise.all(nets.map((net) => net.learnPeers()));
    assert.deepEqual(known, [3, 3, 3]);
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const result = await nets[0]!.propose(built.txs[0]!);
    assert.equal(result.votes >= 2, true);
    assert.equal(nets[1]!.ledger.stateRoot().toHex(), nets[2]!.ledger.stateRoot().toHex());
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("two spends of different notes confirm at the same time", async () => {
  const { nets, buyer, custody } = await three();
  const other = await identityFromMnemonic(await generateMnemonic(128));
  nets.forEach((net) => net.ledger.faucet(other.accountId, ASSET, 5_005n, clientBlinding(4n)));
  try {
    const first = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    const second = nets[0]!.ledger.preparePayment(other, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(31n), changeBlinding: clientBlinding(32n) });
    if ("error" in first || "error" in second) throw new Error("PREPARE_FAILED");
    const [a, b] = await Promise.all([nets[0]!.propose(first.txs[0]!), nets[1]!.propose(second.txs[0]!)]);
    assert.equal(a.votes >= 2 && b.votes >= 2, true);
    assert.notEqual(a.txId, b.txId);
    const root = nets[0]!.ledger.stateRoot().toHex();
    assert.equal(nets.every((net) => net.ledger.stateRoot().toHex() === root), true);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a status id that is not the listed peer is ignored", async () => {
  const { nets } = await three();
  try {
    const port = (nets[1]!.server!.address() as { port: number }).port;
    await nets[1]!.close();
    const { createServer } = await import("node:http");
    const fake = createServer((_req, res) => { res.end(JSON.stringify({ id: "node-0", publicKeyHex: "aa", height: 0 })); });
    await new Promise((resolve) => fake.listen(port, "127.0.0.1", () => resolve(undefined)));
    const known = await nets[0]!.learnPeers();
    assert.equal(known < 3, true);
    fake.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a behind peer restores from a different root, and a replay is rejected", async () => {
  const { nets, buyer, custody, snapshotKey, faucetKey } = await three();
  try {
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    await nets[0]!.propose(built.txs[0]!);
    await assert.rejects(() => nets[1]!.propose(built.txs[0]!), /REPLAY|QUORUM_NOT_MET|QUORUM_NULLIFIER_SPENT/);
    const behind = new PeerNet("behind", UepLedger.restore(nets[0]!.ledger.snapshot(), { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] }), nets[0]!.quorum ? generateEd25519KeyPair().privateKey : generateEd25519KeyPair().privateKey, "00", nets.map((net) => ({ id: net.id, url: `http://127.0.0.1:${(net.server!.address() as { port: number }).port}` })), new Map());
    behind.ledger = UepLedger.restore(await (async () => {
      const { generateMnemonic, identityFromMnemonic } = await import("../identity/index.ts");
      const seed = assembleNode({ custody, feeAccount: await identityFromMnemonic(await generateMnemonic(128)), snapshotKey, faucetKey });
      seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
      return seed.ledger.snapshot();
    })(), { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] });
    const caught = await behind.catchUp({ authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] }, { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey });
    assert.equal(caught, true);
    assert.equal(behind.ledger.stateRoot().toHex(), nets[0]!.ledger.stateRoot().toHex());
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a spend that never gets two votes does not lock the note", async () => {
  const { nets, buyer, custody } = await three();
  try {
    const held = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in held) throw new Error(held.error.code);
    const window = nets[0]!.ledger.policy.config.windowHeights;
    for (const net of nets) net.ledger.advanceHeight(window);
    const other = await identityFromMnemonic(await generateMnemonic(128));
    const next = nets[0]!.ledger.preparePayment(buyer, other.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(41n), changeBlinding: clientBlinding(42n) });
    if ("error" in next) throw new Error(next.error.code);
    const result = await nets[0]!.propose(next.txs[0]!);
    assert.equal(result.votes >= 2, true);
    await assert.rejects(() => nets[1]!.propose(held.txs[0]!), /DOUBLE_SPEND|QUORUM_NULLIFIER_SPENT|QUORUM_NOT_MET|QUORUM_EQUIVOCATION/);
    assert.equal(nets[0]!.ledger.stateRoot().toHex(), nets[2]!.ledger.stateRoot().toHex());
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("catchUp does not replace a newer ledger with an older snapshot", async () => {
  const { nets, buyer, custody, snapshotKey, faucetKey, trust, keys } = await three();
  try {
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    await nets[0]!.propose(built.txs[0]!);
    const newer = nets[0]!.ledger.stateRoot().toHex();
    const older = new PeerNet("older", UepLedger.restore(nets[0]!.ledger.snapshot(), trust, keys), generateEd25519KeyPair().privateKey, "00", [], new Map());
    older.ledger = UepLedger.restore(await (async () => {
      const fee = await identityFromMnemonic(await generateMnemonic(128));
      const seed = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey });
      seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
      return seed.ledger.snapshot();
    })(), trust, keys);
    const port = await older.listen(0);
    nets[0]!.peers = [{ id: "older", url: `http://127.0.0.1:${port}` }];
    const caught = await nets[0]!.catchUp(trust, keys);
    assert.equal(caught, false);
    assert.equal(nets[0]!.ledger.stateRoot().toHex(), newer);
    assert.equal(nets[0]!.ledger.txs.length > older.ledger.txs.length, true);
    await older.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("sixteen spends of different notes confirm together", async () => {
  const { nets, custody } = await three();
  const buyers = await Promise.all(Array.from({ length: 16 }, () => generateMnemonic(128).then(identityFromMnemonic)));
  try {
    buyers.forEach((buyer, i) => nets.forEach((net) => net.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(BigInt(1000 + i)))));
    const txs = buyers.map((buyer, i) => {
      const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(BigInt(2000 + i)), changeBlinding: clientBlinding(BigInt(3000 + i)) });
      if ("error" in built) throw new Error(built.error.code);
      return built.txs[0]!;
    });
    const results = await Promise.all(txs.map((tx, i) => nets[i % 3]!.propose(tx)));
    assert.equal(results.every((item) => item.votes >= 2), true);
    const root = nets[0]!.ledger.stateRoot().toHex();
    assert.equal(nets.every((net) => net.ledger.stateRoot().toHex() === root), true);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("POST without JSON content type is rejected before parsing or authentication", async () => {
  const { nets, peers } = await three();
  try {
    const res = await fetch(peers[1]!.url + "/tx", { method: "POST", body: JSON.stringify({ tx: {} }) });
    assert.equal(res.status, 415);
    assert.equal((await res.json() as { error: string }).error, "UNSUPPORTED_MEDIA_TYPE");
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("an unsigned JSON peer message is rejected", async () => {
  const { nets, peers } = await three();
  try {
    const res = await fetch(peers[1]!.url + "/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: {} }) });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { error: string }).error, "PEER_AUTH");
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a partitioned peer catches up to the same root when it returns", async () => {
  const { nets, buyer, custody, voterKeys, voters, snapshotKey, faucetKey, trust, keys } = await three();
  try {
    await nets[2]!.close();
    nets[0]!.peers = nets[0]!.peers.filter((peer) => peer.id !== "node-2");
    nets[1]!.peers = nets[1]!.peers.filter((peer) => peer.id !== "node-2");
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    await nets[0]!.propose(built.txs[0]!);
    const ahead = nets[0]!.ledger.stateRoot().toHex();
    const fee = await identityFromMnemonic(await generateMnemonic(128));
    const seed = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey });
    seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
    const returned = new PeerNet("node-2", UepLedger.restore(seed.ledger.snapshot(), trust, keys), voterKeys[2]!.privateKey, voterKeys[2]!.publicKeyHex, [], voters);
    await returned.listen(0);
    returned.peers = [
      { id: "node-0", url: `http://127.0.0.1:${(nets[0]!.server!.address() as { port: number }).port}` },
      { id: "node-1", url: `http://127.0.0.1:${(nets[1]!.server!.address() as { port: number }).port}` },
    ];
    assert.equal(await returned.catchUp(trust, keys), true);
    assert.equal(returned.ledger.stateRoot().toHex(), ahead);
    await returned.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a spoofed status cannot replace an authorized voter key", async () => {
  const { nets } = await three();
  try {
    const before = nets[0]!.knownVoter("node-1");
    const port = (nets[1]!.server!.address() as { port: number }).port;
    await nets[1]!.close();
    const { createServer } = await import("node:http");
    const fake = createServer((_req, res) => { res.end(JSON.stringify({ id: "node-1", publicKeyHex: "aa".repeat(32), height: 0 })); });
    await new Promise((resolve) => fake.listen(port, "127.0.0.1", () => resolve(undefined)));
    await nets[0]!.learnPeers();
    assert.equal(nets[0]!.knownVoter("node-1"), before);
    const forged = { voterId: "node-1", publicKeyHex: "aa".repeat(32), signature: "00" };
    assert.throws(() => nets[0]!.quorum.confirm("tx-a", ["null-1"], [forged, forged]), /QUORUM_NOT_MET/);
    fake.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a bad snapshot does not replace the ledger", async () => {
  const { nets, trust, keys } = await three();
  try {
    const mine = nets[0]!.ledger.stateRoot().toHex();
    const port = (nets[1]!.server!.address() as { port: number }).port;
    await nets[1]!.close();
    const { createServer } = await import("node:http");
    const fake = createServer((req, res) => {
      if (req.url === "/status") return res.end(JSON.stringify({ id: "node-1", height: 99, txCount: 99, stateRoot: "aa", publicKeyHex: nets[0]!.knownVoter("node-1") }));
      res.end("{");
    });
    await new Promise((resolve) => fake.listen(port, "127.0.0.1", () => resolve(undefined)));
    assert.equal(await nets[0]!.catchUp(trust, keys), false);
    assert.equal(nets[0]!.ledger.stateRoot().toHex(), mine);
    fake.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a commit that nobody acknowledges is not reported as applied", async () => {
  const { nets, buyer, custody, voterKeys } = await three();
  try {
    const port = (nets[1]!.server!.address() as { port: number }).port;
    await nets[1]!.close();
    await nets[2]!.close();
    const { createServer } = await import("node:http");
    const { signEd25519 } = await import("../core/ed25519.ts");
    const fake = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/tx") {
        const txId = body.payload.tx.txId;
        const signature = signEd25519(`uep-quorum:uep-testnet-1:EARTH:${txId}`, voterKeys[1]!.privateKey);
        return res.end(JSON.stringify({ vote: { voterId: "node-1", publicKeyHex: voterKeys[1]!.publicKeyHex, signature } }));
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise((resolve) => fake.listen(port, "127.0.0.1", () => resolve(undefined)));
    nets[0]!.peers = [{ id: "node-1", url: `http://127.0.0.1:${port}` }];
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const before = nets[0]!.ledger.txs.length;
    await assert.rejects(() => nets[0]!.propose(built.txs[0]!), /COMMIT_NOT_ACKED/);
    assert.equal(nets[0]!.ledger.txs.length, before);
    fake.close();
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("nodes with different local configuration accept the same spend", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = [0, 1, 2].map(() => generateEd25519KeyPair());
  const voters = new Map(voterKeys.map((key, i) => [`node-${i}`, key.publicKeyHex]));
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fees = await Promise.all([0, 1, 2].map(() => generateMnemonic(128).then(identityFromMnemonic)));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fees[0]!, snapshotKey, faucetKey, adminId: "admin-0", noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nodes = [0, 1, 2].map((i) => assembleNode({ custody, feeAccount: fees[i]!, snapshotKey, faucetKey, adminId: `admin-${i}`, noteBlindingDomain: BigInt(7 + i), ledger: UepLedger.restore(genesis, trust, keys) }));
  const nets = nodes.map((node, i) => new PeerNet(`node-${i}`, node.ledger, voterKeys[i]!.privateKey, voterKeys[i]!.publicKeyHex, [], voters));
  const ports = await Promise.all(nets.map((net) => net.listen(0)));
  const peers = ports.map((port, i) => ({ id: `node-${i}`, url: `http://127.0.0.1:${port}` }));
  nets.forEach((net, i) => { net.peers = peers.filter((peer) => peer.id !== `node-${i}`); });
  try {
    assert.equal(new Set(nodes.map((node) => node.admin.identityId)).size, 3);
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    await nets[0]!.propose(built.txs[0]!);
    const root = nets[0]!.ledger.stateRoot().toHex();
    assert.equal(nets.every((net) => net.ledger.stateRoot().toHex() === root), true);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("a public read shows the root and recent spends without a signature", async () => {
  const { nets, peers, buyer, custody } = await three();
  try {
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const result = await nets[0]!.propose(built.txs[0]!);
    const res = await fetch(peers[0]!.url + "/txs");
    assert.equal(res.status, 200);
    const body = await res.json() as { stateRoot: string; recent: string[]; txCount: number };
    assert.equal(body.stateRoot, result.stateRoot);
    assert.equal(body.recent.includes(result.txId), true);
    assert.equal(body.txCount >= 1, true);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});


test("authenticated PeerNet transports BFT proposal, prevote QC, precommit QC and commit to four validators", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const validatorKeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators: BftValidator[] = validatorKeys.map((key, i) => ({ id: `bft-${i}`, publicKeyHex: key.publicKeyHex }));
  const voters = new Map(validators.map(v => [v.id, v.publicKeyHex]));
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 19n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const restoreKeys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const journalDir = mkdtempSync(join(tmpdir(), "uep-bft-journal-"));
  const nets = validatorKeys.map((key, i) => new PeerNet(`bft-${i}`, UepLedger.restore(genesis, trust, restoreKeys), key.privateKey, key.publicKeyHex, [], voters, 2, i === 0 ? journalDir : undefined));
  const kernels = nets.map(net => new BftConsensusKernel({ networkId: net.ledger.networkId, domainId: net.ledger.domainId }, validators, 1));
  nets.forEach((net, i) => net.configureBftConsensus(kernels[i]!));
  const ports = await Promise.all(nets.map(net => net.listen(0)));
  const peers: Peer[] = ports.map((port, i) => ({ id: `bft-${i}`, url: `http://127.0.0.1:${port}` }));
  nets.forEach((net, i) => { net.peers = peers.filter(peer => peer.id !== `bft-${i}`); });
  try {
    const parentRoot = nets[0]!.ledger.stateRoot().toHex();
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(81n), changeBlinding: clientBlinding(82n) });
    if ("error" in built) throw new Error(built.error.code);
    const tx = built.txs[0]!;
    const blockId = tx.txId.toHex();
    const proposal = { networkId: nets[0]!.ledger.networkId, domainId: nets[0]!.ledger.domainId, height: nets[0]!.ledger.height + 1, round: 0, proposerId: "bft-0", parentRoot, blockId };
    const certificate = await nets[0]!.bftPropose(proposal, tx);
    assert.equal(certificate.phase, "precommit");
    assert.equal(certificate.votes.length >= 3, true);
    assert.equal(kernels.every(kernel => kernel.exportState().committed.some(([height, id]) => height === String(proposal.height) && id === blockId)), true);
    const roots = nets.map(net => net.ledger.stateRoot().toHex());
    assert.equal(new Set(roots).size, 1, "all validators must apply the certified transaction to the same root");
    assert.notEqual(roots[0], parentRoot, "a valid BFT commit must advance the ledger state");

    // Recreate the leader from the pre-commit snapshot and replay the durable certified-commit journal.
    const restarted = new PeerNet("bft-0", UepLedger.restore(genesis, trust, restoreKeys), validatorKeys[0]!.privateKey,
      validatorKeys[0]!.publicKeyHex, [], voters, 2, journalDir);
    const restartedKernel = new BftConsensusKernel({ networkId: restarted.ledger.networkId, domainId: restarted.ledger.domainId }, validators, 1);
    restarted.configureBftConsensus(restartedKernel);
    assert.equal(await restarted.recoverBftCommits(), 1);
    assert.equal(restarted.ledger.stateRoot().toHex(), roots[0]);
    await restarted.close();
  } finally {
    await Promise.all(nets.map(net => net.close()));
    rmSync(journalDir, { recursive: true, force: true });
  }
});
