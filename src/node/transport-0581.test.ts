/** 0.5.81 item 9: peer envelope v2 (network/epoch/height binding, replay), limits, verifiable key rotation/revocation. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { clientBlinding } from "../core/client-note.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { PeerNet, PEER_SERVER_LIMITS } from "./peer-net.ts";
import { PEER_ENVELOPE_LIMITS, PeerKeyRegistry, PeerReplayGuard, signKeyStatement, signPeerEnvelope, type KeyRevocation, type KeyRotation } from "./peer-envelope.ts";

const D = { networkId: "uep-testnet", domainId: "EARTH", epoch: 0 };
const K = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
const keyOf = (id: string) => K[Number(id.slice(1))]?.publicKeyHex;

test("item 9: v2 envelope is refused across network, domain, epoch, when stale, replayed, tampered or badly signed", () => {
  const g = new PeerReplayGuard(D);
  const env = signPeerEnvelope(D, "v1", "/vote", 100, "n-1", { a: 1 }, K[1]!.privateKey);
  g.verify(env, "/vote", 100, keyOf);
  assert.throws(() => g.verify(env, "/vote", 100, keyOf), /PEER_REPLAY/);
  const cases: [unknown, RegExp, number?][] = [
    [signPeerEnvelope({ ...D, networkId: "other" }, "v1", "/vote", 100, "n-2", {}, K[1]!.privateKey), /PEER_DOMAIN_MISMATCH/],
    [signPeerEnvelope({ ...D, domainId: "MARS" }, "v1", "/vote", 100, "n-3", {}, K[1]!.privateKey), /PEER_DOMAIN_MISMATCH/],
    [signPeerEnvelope({ ...D, epoch: 1 }, "v1", "/vote", 100, "n-4", {}, K[1]!.privateKey), /PEER_EPOCH_MISMATCH/],
    // Stale: more than the window below the highest height already accepted from v1 (100).
    [signPeerEnvelope(D, "v1", "/vote", 100 - PEER_ENVELOPE_LIMITS.replayWindow - 1, "n-5", {}, K[1]!.privateKey), /PEER_ENVELOPE_STALE/],
    [{ ...signPeerEnvelope(D, "v1", "/vote", 100, "n-6", { a: 1 }, K[1]!.privateKey), payload: { a: 2 } }, /PEER_AUTH/],
    [{ ...signPeerEnvelope(D, "v1", "/vote", 100, "n-7", {}, K[1]!.privateKey), height: 101 }, /PEER_AUTH/],
    [signPeerEnvelope(D, "v1", "/vote", 100, "n-8", {}, K[2]!.privateKey), /PEER_AUTH/],
    [signPeerEnvelope(D, "v1", "/vote", 100, "x".repeat(65), {}, K[1]!.privateKey), /PEER_NONCE_INVALID/],
    [signPeerEnvelope(D, "v9", "/vote", 100, "n-9", {}, K[1]!.privateKey), /PEER_AUTH/],
  ];
  for (const [e, re] of cases) assert.throws(() => g.verify(e as never, "/vote", 100, keyOf), re);
  // Signed for another path: refused on this one.
  assert.throws(() => g.verify(signPeerEnvelope(D, "v1", "/tx", 100, "n-10", {}, K[1]!.privateKey), "/vote", 100, keyOf), /PEER_AUTH/);
  // A sender far behind the receiver is not refused (lagging validators can still talk).
  g.verify(signPeerEnvelope(D, "v2", "/vote", 1, "lag-1", {}, K[2]!.privateKey), "/vote", 10_000, keyOf);
  // A refused envelope does not burn its nonce.
  g.verify(signPeerEnvelope(D, "v1", "/vote", 100, "n-6", { a: 1 }, K[1]!.privateKey), "/vote", 100, keyOf);
});

test("item 9: key rotation needs the old key and a validator quorum; revocation needs a quorum; both are height-scoped and sequence-checked", () => {
  const genesis = new Map(K.map((k, i) => [`v${i}`, k.publicKeyHex]));
  const reg = new PeerKeyRegistry("uep-testnet", genesis, 2);
  const fresh = generateEd25519KeyPair();
  const rot: KeyRotation = { kind: "rotate", networkId: "uep-testnet", peerId: "v3", oldKeyHex: K[3]!.publicKeyHex, newKeyHex: fresh.publicKeyHex, fromHeight: 50, sequence: 1 };
  const sig = (s: KeyRotation | KeyRevocation, ids: number[], keys = K) => ids.map(i => signKeyStatement(s, `v${i}`, keys[i]!.privateKey));
  assert.throws(() => reg.apply({ ...rot, signatures: sig(rot, [0, 1]) }, 10), /PEER_KEY_OLD_SIGNATURE/);
  assert.throws(() => reg.apply({ ...rot, signatures: sig(rot, [3, 0]) }, 10), /PEER_KEY_QUORUM/);
  assert.throws(() => reg.apply({ ...rot, signatures: sig(rot, [3, 0, 0]) }, 10), /PEER_KEY_QUORUM/, "duplicate signer counts once");
  assert.throws(() => reg.apply({ ...rot, fromHeight: 10, signatures: sig({ ...rot, fromHeight: 10 }, [3, 0, 1]) }, 10), /PEER_KEY_HEIGHT/);
  assert.throws(() => reg.apply({ ...rot, networkId: "x", signatures: sig({ ...rot, networkId: "x" }, [3, 0, 1]) }, 10), /PEER_KEY_NETWORK/);
  assert.throws(() => reg.apply({ ...rot, newKeyHex: K[0]!.publicKeyHex.slice(0, 63) + "z", signatures: sig({ ...rot, newKeyHex: K[0]!.publicKeyHex.slice(0, 63) + "z" }, [3, 0, 1]) }, 10), /PEER_KEY_NEW_INVALID/);
  reg.apply({ ...rot, signatures: sig(rot, [3, 0, 1]) }, 10);
  assert.equal(reg.keyAt("v3", 49), K[3]!.publicKeyHex);
  assert.equal(reg.keyAt("v3", 50), fresh.publicKeyHex);
  assert.throws(() => reg.apply({ ...rot, signatures: sig(rot, [3, 0, 1]) }, 10), /PEER_KEY_SEQUENCE/, "replayed statement refused");
  const rev: KeyRevocation = { kind: "revoke", networkId: "uep-testnet", peerId: "v3", keyHex: fresh.publicKeyHex, fromHeight: 60, sequence: 2 };
  assert.throws(() => reg.apply({ ...rev, signatures: sig(rev, [0]) }, 20), /PEER_KEY_QUORUM/);
  reg.apply({ ...rev, signatures: sig(rev, [0, 2]) }, 20);
  assert.equal(reg.keyAt("v3", 59), fresh.publicKeyHex);
  assert.equal(reg.keyAt("v3", 60), undefined);
  // An envelope from a revoked key at a height after revocation is refused.
  const g = new PeerReplayGuard(D);
  assert.throws(() => g.verify(signPeerEnvelope(D, "v3", "/vote", 60, "r1", {}, fresh.privateKey), "/vote", 60, (id, h) => reg.keyAt(id, h)), /PEER_AUTH/);
  g.verify(signPeerEnvelope(D, "v3", "/vote", 55, "r2", {}, fresh.privateKey), "/vote", 60, (id, h) => reg.keyAt(id, h));
});

test("item 9: PeerNet speaks v2, refuses replays over HTTP, can retire v1 at a height, and sets connection limits and timeouts", async () => {
  const snapshotKey = generateEd25519KeyPair(), faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fee = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(custody.accountId, "uep-test/teur", 1_000n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const voters = new Map(K.slice(0, 3).map((k, i) => [`node-${i}`, k.publicKeyHex]));
  const net = new PeerNet("node-0", UepLedger.restore(genesis, trust, { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey }), K[0]!.privateKey, K[0]!.publicKeyHex, [], voters);
  const port = await net.listen(0);
  try {
    assert.equal(net.server!.maxConnections, PEER_SERVER_LIMITS.maxConnections);
    assert.equal(net.server!.headersTimeout, PEER_SERVER_LIMITS.headersTimeoutMs);
    assert.equal(net.server!.requestTimeout, PEER_SERVER_LIMITS.requestTimeoutMs);
    const d = { networkId: net.ledger.networkId, domainId: net.ledger.domainId, epoch: 0 };
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.status);
    const env = signPeerEnvelope(d, "node-1", "/vote", net.ledger.height, "once", { vote: null }, K[1]!.privateKey);
    const first = await post(env);
    assert.notEqual(first, 401); assert.notEqual(first, 409);
    assert.equal(await post(env), 409, "replayed envelope");
    assert.equal(await post(signPeerEnvelope({ ...d, networkId: "other" }, "node-1", "/vote", net.ledger.height, "x2", {}, K[1]!.privateKey)), 401);
    // Outgoing envelopes are v2.
    const out = (net as unknown as { signed(p: string, x: unknown): Record<string, unknown> }).signed("/vote", { a: 1 });
    assert.equal(out.v, 2); assert.equal(out.networkId, net.ledger.networkId);
    // v1 is still accepted by default (compatibility), and refused once retired.
    const { signEd25519 } = await import("../core/ed25519.ts");
    const v1 = { from: "node-1", payload: { vote: null }, signature: signEd25519(`uep-peer:node-1:/vote:${JSON.stringify({ vote: null })}`, K[1]!.privateKey) };
    assert.notEqual(await post(v1), 401);
    net.legacyEnvelopeUntilHeight = net.ledger.height;
    assert.equal(await post(v1), 401);
  } finally { await net.close(); }
});
