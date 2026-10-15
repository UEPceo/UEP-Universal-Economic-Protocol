/** Item 4 (0.5.81): snapshot integrity, authorization and no-rollback rules, gathered in one place. */
import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger, signSnapshot } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { PeerNet, extendsHistory } from "./peer-net.ts";

const ASSET = "uep-test/teur";
const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;
const decode = (_k: string, v: unknown) => v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;
const roundTrip = <T>(x: T): any => JSON.parse(JSON.stringify(x, encode), decode);

async function fixture() {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 51n });
  seed.ledger.faucet(buyer.accountId, ASSET, 50_050n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const fresh = () => UepLedger.restore(genesis, trust, keys);
  const pay = (l: UepLedger, amount: bigint, b: bigint) => {
    const built = l.preparePayment(buyer, custody.accountId, ASSET, amount, l.height, { outputBlinding: clientBlinding(b), changeBlinding: clientBlinding(b + 1n) });
    if ("error" in built) throw new Error(built.error.code);
    const r = l.submit(built.txs[0]!); if ("error" in r) throw new Error(r.error.code);
  };
  return { genesis, trust, keys, fresh, pay, snapshotKey };
}

test("item 4: a truncated snapshot file does not parse; a truncated transaction list fails integrity", async () => {
  const f = await fixture();
  const l = f.fresh(); f.pay(l, 100n, 10n); f.pay(l, 101n, 12n);
  const text = JSON.stringify(l.snapshot(), encode);
  assert.throws(() => JSON.parse(text.slice(0, Math.floor(text.length / 2)), decode), SyntaxError);
  const snap = roundTrip(l.snapshot());
  snap.txs = snap.txs.slice(0, 1);
  assert.throws(() => UepLedger.restore(snap, f.trust, f.keys), /INVALID_SNAPSHOT_/);
});

test("item 4: a corrupted field (state root, balance, height) fails integrity", async () => {
  const f = await fixture();
  const l = f.fresh(); f.pay(l, 100n, 10n);
  for (const mutate of [
    (s: any) => { s.height = s.height + 5; },
    (s: any) => { s.balances[0][1] = "999999999"; },
    (s: any) => { s.networkId = s.networkId + "-x"; },
  ]) {
    const snap = roundTrip(l.snapshot());
    mutate(snap);
    assert.throws(() => UepLedger.restore(snap, f.trust, f.keys), /INVALID_SNAPSHOT_/);
  }
});

test("item 4: a snapshot of a newer (unknown) format is refused; a snapshot signed by an unknown key is refused", async () => {
  const f = await fixture();
  const l = f.fresh();
  const newer = roundTrip(l.snapshot()); newer.formatVersion = 999;
  assert.throws(() => UepLedger.restore(newer, f.trust, f.keys), /INVALID_SNAPSHOT_(VERSION|HASH|SIGNATURE)/);
  const stranger = generateEd25519KeyPair();
  const { snapshotHash: _h, signatures: _s, ...payload } = roundTrip(l.snapshot());
  const resigned = signSnapshot(payload, [stranger.privateKey]);
  assert.throws(() => UepLedger.restore(roundTrip(resigned), f.trust, f.keys), /INVALID_SNAPSHOT_(TRUST|SIGNATURE|THRESHOLD)/);
});

test("item 4: rollback below the current height is refused unless the operator forces it explicitly", async () => {
  const f = await fixture();
  const old = f.fresh().snapshot();
  const l = f.fresh(); l.advanceHeight(5);
  assert.throws(() => UepLedger.restore(old, f.trust, f.keys, { minHeight: l.height }), /HEIGHT_REGRESSION/);
  assert.throws(() => UepLedger.restore(old, f.trust, f.keys, { replaces: l }), /HEIGHT_REGRESSION/);
  assert.ok(UepLedger.restore(old, f.trust, f.keys, { minHeight: l.height, allowHeightRegression: true }));
});

test("item 4: catchUp refuses a validly signed peer snapshot from a forked history and keeps its ledger", async () => {
  const f = await fixture();
  const a = f.fresh(); f.pay(a, 100n, 10n);
  const b = f.fresh(); f.pay(b, 222n, 30n); f.pay(b, 223n, 32n); // different first spend, longer
  assert.equal(extendsHistory(a, b), false);
  const peer = new PeerNet("peer", b, generateEd25519KeyPair().privateKey, "00", [], new Map());
  const port = await peer.listen(0);
  const me = new PeerNet("me", a, generateEd25519KeyPair().privateKey, "00", [{ id: "peer", url: `http://127.0.0.1:${port}` }], new Map());
  try {
    const root = a.stateRoot().toHex();
    assert.equal(await me.catchUp(f.trust, f.keys), false);
    assert.equal(me.ledger.stateRoot().toHex(), root);
  } finally { await peer.close(); }
});

test("item 4: catchUp accepts a peer snapshot that extends this node's history", async () => {
  const f = await fixture();
  const a = f.fresh(); f.pay(a, 100n, 10n);
  const b = UepLedger.restore(roundTrip(a.snapshot()), f.trust, f.keys); f.pay(b, 101n, 12n);
  assert.equal(extendsHistory(a, b), true);
  const peer = new PeerNet("peer", b, generateEd25519KeyPair().privateKey, "00", [], new Map());
  const port = await peer.listen(0);
  const me = new PeerNet("me", a, generateEd25519KeyPair().privateKey, "00", [{ id: "peer", url: `http://127.0.0.1:${port}` }], new Map());
  try {
    assert.equal(await me.catchUp(f.trust, f.keys), true);
    assert.equal(me.ledger.stateRoot().toHex(), b.stateRoot().toHex());
  } finally { await peer.close(); }
});

test("item 4: outside BFT mode the node's own persisted height floor refuses an older or forked ledger at start-up and on catch-up", async () => {
  const { HeightFloor } = await import("./height-floor.ts");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "uep-floor-"));
  try {
    const floor = new HeightFloor(dir);
    const l = f.fresh(); l.advanceHeight(5); f.pay(l, 100n, 10n);
    floor.record(l);
    assert.equal(floor.read()!.height, l.height);
    const old = f.fresh();
    assert.throws(() => floor.check(old), /LEDGER_BELOW_HEIGHT_FLOOR/);
    // Same height, other history: refused.
    const fork = f.fresh(); fork.advanceHeight(5); f.pay(fork, 999n, 40n);
    assert.equal(fork.height, l.height);
    assert.throws(() => floor.check(fork), /LEDGER_ROOT_AT_FLOOR_MISMATCH/);
    floor.check(l);
    // The floor never goes down.
    floor.record(old); assert.equal(floor.read()!.height, l.height);
    // Explicit operator override is possible and logged.
    const logs: string[] = [];
    floor.check(old, { allowRegression: true, log: (m) => logs.push(m) });
    assert.match(logs[0]!, /overridden by operator/);
    // PeerNet with this state directory refuses to start on the older ledger.
    const key = generateEd25519KeyPair();
    assert.throws(() => new PeerNet("n0", old, key.privateKey, key.publicKeyHex, [], new Map([["n0", key.publicKeyHex]]), 1, dir), /LEDGER_BELOW_HEIGHT_FLOOR/);
    new PeerNet("n0", l, key.privateKey, key.publicKeyHex, [], new Map([["n0", key.publicKeyHex]]), 1, dir);
    // A corrupt floor file is an error, not a silent reset.
    writeFileSync(floor.path, "{\"version\":1,\"height\":-1}");
    assert.throws(() => floor.read(), /HEIGHT_FLOOR_CORRUPT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
