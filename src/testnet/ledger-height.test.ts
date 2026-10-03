/**
 * v0.5.0 (ADR 0002): the single-node testnet exposes a deterministic block
 * height. It starts at 0, only moves through advanceHeight(), is part of the
 * signed snapshot (format 7) and is the only time the ledger's transitions use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger, SNAPSHOT_FORMAT_VERSION, snapshotHash, type UepLedgerSnapshot } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

const EUR = "uep-test/teur";
const S1 = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const TRUST = { authorities: [S1.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };
const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const ledger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [S1.privateKey], faucetSigningKey: FAUCET.privateKey });

function resign(snap: UepLedgerSnapshot): UepLedgerSnapshot {
  const { snapshotHash: _h, signatures: _s, ...payload } = snap as UepLedgerSnapshot & Record<string, unknown>;
  const hash = snapshotHash(payload as UepLedgerSnapshot);
  return { ...(payload as UepLedgerSnapshot), snapshotHash: hash, signatures: [{ publicKey: S1.publicKeyHex, signature: signEd25519(hash, S1.privateKey) }] };
}

test("height: starts at 0, advances only through advanceHeight(), never through transitions", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  assert.equal(l.height, 0);
  l.faucet(a.accountId, EUR, 10_000n);
  const p = l.prepareSpend(a, b.accountId, EUR, 100n);
  assert.ok("tx" in p);
  if (!("tx" in p)) return;
  assert.equal(p.tx.createdAt, 0); // createdAt is the preparing ledger's height
  assert.ok("tx" in l.submit(p.tx));
  assert.equal(l.height, 0); // committed transitions belong to the current height
  assert.equal(l.advanceHeight(), 1);
  assert.equal(l.advanceHeight(9), 10);
  assert.equal(l.advanceHeight(0), 10);
  assert.throws(() => l.advanceHeight(-1), /HEIGHT_ADVANCE_INVALID/);
  assert.throws(() => l.advanceHeight(0.5), /HEIGHT_ADVANCE_INVALID/);
  assert.throws(() => { (l as unknown as { height: number }).height = 99; });
  l.reconcilePending();
  assert.equal(l.lastReconcileAt, 10); // a height, not a wall-clock value
});

test("height: two replicas fed the same inputs reach the same height and state", async () => {
  const a = await identity();
  const run = () => {
    const l = ledger();
    l.faucet(a.accountId, EUR, 500n);
    l.advanceHeight(3);
    l.faucet(a.accountId, EUR, 700n);
    l.advanceHeight(2);
    return { h: l.height, root: l.stateRoot().toHex(), reconcile: (l.reconcilePending(), l.lastReconcileAt) };
  };
  const first = run();
  assert.deepEqual(run(), first);
  assert.equal(first.h, 5);
  assert.equal(first.reconcile, 5);
});

test("height: carried by the signed snapshot (format 7) and checked on restore", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 1_000n);
  l.advanceHeight(42);
  l.reconcilePending();
  l.advanceHeight(8);
  const snap = l.snapshot();
  assert.equal(SNAPSHOT_FORMAT_VERSION, 7);
  assert.equal(snap.formatVersion, 7);
  assert.equal(snap.height, 50);
  assert.equal(snap.lastReconcileAt, 42);
  assert.equal(snap.policy.windowHeights, 12);
  assert.equal((snap.policy as Record<string, unknown>).windowMs, undefined);
  const restored = UepLedger.restore(structuredClone(snap), TRUST);
  assert.equal(restored.height, 50);
  assert.equal(restored.lastReconcileAt, 42);
  assert.equal(restored.policy.config.windowHeights, 12);
  // The height is signed: changing it without re-signing breaks the hash.
  const tampered = structuredClone(snap) as UepLedgerSnapshot;
  tampered.height = 51;
  assert.throws(() => UepLedger.restore(tampered, TRUST), /INVALID_SNAPSHOT_HASH/);
  for (const [height, last] of [[-1, 0], [1.5, 0], [10, 11], [Number.NaN, 0]] as const) {
    const bad = structuredClone(snap) as UepLedgerSnapshot & { height: number; lastReconcileAt: number };
    bad.height = height;
    bad.lastReconcileAt = last;
    assert.throws(() => UepLedger.restore(resign(bad), TRUST), /INVALID_SNAPSHOT_HEIGHT/, `${height}/${last}`);
  }
  const missing = structuredClone(snap) as Record<string, unknown>;
  delete missing.height;
  assert.throws(() => UepLedger.restore(resign(missing as UepLedgerSnapshot), TRUST), /INVALID_SNAPSHOT_HEIGHT/);
});

test("height: the policy rate window is measured in heights (default 12 = 60 s)", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.policy.config.maxTxPerWindow = 2;
  l.faucet(a.accountId, EUR, 10_000n);
  const pay = () => { const p = l.prepareSpend(a, b.accountId, EUR, 10n); return "tx" in p ? ("tx" in l.submit(p.tx) ? "OK" : "SUBMIT") : p.error.code; };
  assert.equal(pay(), "OK");
  assert.equal(pay(), "OK");
  assert.equal(pay(), "POLICY"); // third spend at the same height
  l.advanceHeight(11);
  assert.equal(pay(), "POLICY"); // still inside the 12-height window
  l.advanceHeight(1);
  assert.equal(pay(), "OK"); // new window at height 12
  assert.equal(l.policy.windowVolume(a.accountId.toHex(), EUR, l.height), 10n);
});
