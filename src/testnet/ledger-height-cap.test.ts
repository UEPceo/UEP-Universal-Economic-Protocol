/**
 * v0.5.3 (snapshot format 9): the 12-block catch-up cap is a state invariant.
 * Every advanceHeight() call that seals blocks counts one tick; a capped
 * ledger keeps height <= ticks x 12, and restore() re-checks it, also across
 * chain links and against a checkpoint (at most 12 heights per added tick).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { UepLedger, checkpointOf, snapshotHash, type UepLedgerSnapshot } from "./ledger.ts";
import { MAX_BLOCKS_PER_TICK } from "../core/height.ts";
import { migrateSnapshotPayload } from "./snapshot-migrations.ts";
import { TESTNET } from "../network/profiles.ts";

const S1 = generateEd25519KeyPair();
const TRUST = { authorities: [S1.publicKeyHex] };
const make = (unbounded = false) => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null, snapshotSigningKeys: [S1.privateKey], ...(unbounded ? { testOnlyUnboundedHeightAdvance: true } : {}) });

function resign(payload: Record<string, unknown>): UepLedgerSnapshot {
  const { snapshotHash: _h, signatures: _s, ...p } = payload;
  const hash = snapshotHash(p as UepLedgerSnapshot);
  return { ...(p as UepLedgerSnapshot), snapshotHash: hash, signatures: [{ publicKey: S1.publicKeyHex, signature: signEd25519(hash, S1.privateKey) }] };
}

test("height cap: every sealing call counts a tick, and the snapshot records ticks and the cap", () => {
  const l = make();
  assert.equal(MAX_BLOCKS_PER_TICK, 12);
  l.advanceHeight(12);
  l.advanceHeight(0); // seals nothing: no tick
  l.advanceHeight(5);
  assert.throws(() => l.advanceHeight(13), /HEIGHT_ADVANCE_CAP/);
  assert.deepEqual(l.heightAdvanceRecord(), { count: 2, maxBlocksPerTick: 12, mode: "capped" });
  const snap = l.snapshot();
  assert.deepEqual(snap.ticks, { count: 2, maxBlocksPerTick: 12, mode: "capped" });
  const r = UepLedger.restore(snap, TRUST);
  assert.equal(r.height, 17);
  assert.deepEqual(r.heightAdvanceRecord(), snap.ticks);
});

test("height cap: a signed snapshot whose height exceeds ticks x 12 is rejected on restore", () => {
  const l = make();
  l.advanceHeight(12);
  const snap = l.snapshot();
  const forged = resign({ ...snap, height: 13 });
  assert.throws(() => UepLedger.restore(forged, TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP: height 13 exceeds 1 ticks x 12 blocks/);
  assert.throws(() => UepLedger.restore(resign({ ...snap, ticks: { count: 1, maxBlocksPerTick: 1000, mode: "capped" } }), TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP: maxBlocksPerTick must be 12/);
  assert.throws(() => UepLedger.restore(resign({ ...snap, ticks: { count: -1, maxBlocksPerTick: 12, mode: "capped" } }), TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP: malformed/);
  assert.throws(() => UepLedger.restore(resign({ ...snap, ticks: undefined }), TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP|INVALID_SNAPSHOT_SHAPE|CANON/);
});

test("height cap: across a chain link or a checkpoint the height grows by at most 12 per added tick", () => {
  const l = make();
  l.advanceHeight(10);
  const s1 = l.snapshot();
  l.advanceHeight(12);
  const s2 = l.snapshot();
  assert.equal(UepLedger.restoreChain([s1, s2], TRUST).height, 22);
  // A forged second snapshot that keeps height <= ticks x 12 but jumps 30 heights in one tick.
  const jump = resign({ ...s2, height: 24, ticks: { count: 2, maxBlocksPerTick: 12, mode: "capped" } });
  assert.equal(UepLedger.restore(jump, TRUST).height, 24); // alone it satisfies 24 <= 2 x 12...
  assert.throws(() => UepLedger.restoreChain([s1, jump], TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP: the height grew by more than 12 blocks per tick/);
  assert.throws(() => UepLedger.restore(jump, { ...TRUST, previousSnapshotHash: snapshotHash(s1), checkpoint: checkpointOf(s1) }), /HEIGHT_CAP/);
  // The tick count cannot go backwards against a checkpoint.
  const back = resign({ ...s2, height: 10, ticks: { count: 0, maxBlocksPerTick: 12, mode: "capped" } });
  assert.throws(() => UepLedger.restore(back, { ...TRUST, previousSnapshotHash: snapshotHash(s1), checkpoint: checkpointOf(s1) }), /HEIGHT_CAP/);
  assert.equal(checkpointOf(s1).tickCount, 1);
});

test("height cap: a test-unbounded ledger's snapshot restores only with the test-only restore option", () => {
  const l = make(true);
  l.advanceHeight(1_000);
  const snap = l.snapshot();
  assert.equal(snap.ticks.mode, "test-unbounded");
  assert.throws(() => UepLedger.restore(snap, TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP: the snapshot was written by a ledger without the 12-block cap/);
  // Relabelling it "capped" breaks the signature, and re-signed it violates the cap.
  assert.throws(() => UepLedger.restore({ ...snap, ticks: { ...snap.ticks, mode: "capped" } }, TRUST), /INVALID_SNAPSHOT_HASH/);
  assert.throws(() => UepLedger.restore(resign({ ...snap, ticks: { ...snap.ticks, mode: "capped" } }), TRUST), /INVALID_SNAPSHOT_HEIGHT_CAP/);
  const r = UepLedger.restore(snap, TRUST, {}, { testOnlyUnboundedHeightAdvance: true });
  assert.equal(r.height, 1_000);
  assert.equal(r.advanceHeight(500), 1_500);
});

test("height cap: migration 8 -> 9 derives the smallest tick count consistent with the cap", () => {
  const l = make();
  for (let i = 0; i < 3; i++) l.advanceHeight(7);
  const { snapshotHash: _h, signatures: _s, ticks: _t, ...p9 } = l.snapshot() as unknown as Record<string, unknown>;
  const p8 = { ...p9, formatVersion: 8 };
  const out = migrateSnapshotPayload(p8);
  assert.deepEqual(out.steps, ["8->9"]);
  assert.deepEqual(out.payload.ticks, { count: 2, maxBlocksPerTick: 12, mode: "capped" }); // ceil(21 / 12)
  assert.throws(() => migrateSnapshotPayload({ ...p8, height: -1 }), /MIGRATION_8_9/);
});
