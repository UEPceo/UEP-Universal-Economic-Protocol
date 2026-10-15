import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { txCommitmentOf, txIdFromCommitment, type UepTransaction } from "../core/transaction.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { PeerNet, type Peer } from "./peer-net.ts";

const ASSET = "uep-test/teur";

async function three() {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = [0, 1, 2].map(() => generateEd25519KeyPair());
  const voters = new Map(voterKeys.map((key, i) => [`node-${i}`, key.publicKeyHex]));
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fee = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nets = voterKeys.map((key, i) => new PeerNet(`node-${i}`, UepLedger.restore(genesis, trust, keys), key.privateKey, key.publicKeyHex, [], voters));
  const ports = await Promise.all(nets.map((net) => net.listen(0)));
  const peers: Peer[] = ports.map((port, i) => ({ id: `node-${i}`, url: `http://127.0.0.1:${port}` }));
  nets.forEach((net, i) => { net.peers = peers.filter((peer) => peer.id !== `node-${i}`); });
  return { nets, buyer, custody };
}

/** Same nullifier as `tx`, different content, so a different txId and an invalid sender signature. */
function forge(tx: UepTransaction): UepTransaction {
  const forged: UepTransaction = { ...tx, amount: tx.amount + 1n };
  forged.transactionCommitment = txCommitmentOf(forged);
  forged.txId = txIdFromCommitment(forged.transactionCommitment, forged.nullifier);
  return forged;
}

test("an invalid spend that reuses a nullifier gets no vote and does not block the real spend", async () => {
  const { nets, buyer, custody } = await three();
  try {
    const built = nets[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nets[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
    if ("error" in built) throw new Error(built.error.code);
    const real = built.txs[0]!;
    const forged = forge(real);
    assert.notEqual(forged.txId.toHex(), real.txId.toHex());
    await assert.rejects(() => nets[1]!.propose(forged));
    for (const net of nets) assert.deepEqual(net.quorum.exportState().voted, [], `${net.id} voted for an invalid spend`);
    const result = await nets[0]!.propose(real);
    assert.equal(result.votes >= 2, true);
    assert.equal(nets[1]!.ledger.stateRoot().toHex(), result.stateRoot);
    assert.equal(nets[2]!.ledger.stateRoot().toHex(), result.stateRoot);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("an oversized peer body is rejected with PAYLOAD_TOO_LARGE", async () => {
  const { nets } = await three();
  try {
    const huge = "x".repeat(3 * 1024 * 1024);
    const res = await fetch(nets[0]!.peers[0]!.url + "/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "node-1", signature: "00", payload: { tx: huge } }),
    });
    const body = await res.json() as { error?: string };
    assert.equal(res.status, 413);
    assert.equal(body.error, "PAYLOAD_TOO_LARGE");
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("status reports version, uptime and rate-limit counters", async () => {
  const { nets } = await three();
  try {
    const res = await fetch(nets[0]!.peers[0]!.url + "/status");
    const body = await res.json() as {
      version?: string; uptimeMs?: number; peerCount?: number;
      rateLimit?: { max: number; windowMs: number };
    };
    assert.equal(res.status, 200);
    assert.equal(body.version, "0.5.81");
    assert.equal(typeof body.uptimeMs, "number");
    assert.ok(body.uptimeMs! >= 0);
    assert.equal(typeof body.peerCount, "number");
    assert.equal(body.rateLimit?.max, 120);
    assert.equal(body.rateLimit?.windowMs, 60_000);
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});

test("peer server rejects bad method and content-type", async () => {
  const { nets } = await three();
  try {
    const base = nets[0]!.peers[0]!.url;
    const badMethod = await fetch(base + "/status", { method: "PUT" });
    assert.equal(badMethod.status, 405);
    const badCt = await fetch(base + "/tx", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(badCt.status, 415);
    const okStatus = await fetch(base + "/status");
    const headers = okStatus.headers;
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("x-frame-options"), "DENY");
  } finally {
    await Promise.all(nets.map((net) => net.close()));
  }
});
