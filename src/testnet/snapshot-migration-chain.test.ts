/**
 * A node upgraded from format 6 keeps its snapshot chain: it restores the
 * signed format 6 snapshot (migrated to 7), takes its next snapshot in format
 * 7 linked to the signed one, and a verifier restores the mixed chain.
 * The format 6 snapshot is built in memory from current code (ephemeral
 * keys); the golden fixtures cover snapshots written by the old releases.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { UepLedger, signSnapshot, snapshotHash, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET } from "../network/profiles.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const KEYS = { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey };

/** The format 6 form of a format 7 snapshot (no height, Unix-ms lastReconcileAt, windowMs), signed again. */
function asFormat6(s: UepLedgerSnapshot): UepLedgerSnapshot {
  const { snapshotHash: _h, signatures: _s, height: _height, assetRegistry: _reg, settlementAnchors: _anc, ticks: _ticks, ...p } = s as UepLedgerSnapshot & Record<string, unknown>;
  const { windowHeights, ...policy } = p.policy as unknown as Record<string, unknown>;
  const v6 = { ...p, formatVersion: 6, lastReconcileAt: 1_790_000_000_000, policy: { ...policy, windowMs: (windowHeights as number) * 5000 } };
  return signSnapshot(v6 as never, [SNAPSHOT_KEY.privateKey]);
}

test("a mixed 6 -> 7 snapshot chain restores and keeps its links", async () => {
  const alice = await identityFromMnemonic(await generateMnemonic(128)); // in memory only, discarded
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, ...KEYS });
  l.faucet(l.addressOf(alice.accountId), "uep-test/teur", 50_000n);
  const s6 = asFormat6(l.snapshot());
  assert.equal(s6.formatVersion, 6);

  const upgraded = UepLedger.restore(s6, TRUST, KEYS);
  assert.deepEqual(upgraded.restoredFrom, { formatVersion: 6, migrationSteps: ["6->7", "7->8", "8->9"] });
  assert.equal(upgraded.height, 0);
  assert.equal(upgraded.lastReconcileHeight, 0);
  upgraded.advanceHeight(3);
  upgraded.faucet(upgraded.addressOf(alice.accountId), "asset:test:eur", 1_000n); // legacy id, resolved to uep-test/teur
  const s7 = upgraded.snapshot();
  assert.equal(s7.formatVersion, 9);
  assert.equal(s7.prevSnapshotHash, snapshotHash(s6));
  assert.equal(s7.sequence, s6.sequence + 1);

  const verifier = UepLedger.restoreChain([s6, s7], TRUST);
  assert.equal(verifier.height, 3);
  assert.equal(verifier.restoredFrom?.formatVersion, 9);
  assert.equal(verifier.balanceOfAsset(alice.accountId, "uep-test/teur"), 51_000n);
  assert.equal(verifier.balanceOfAsset(alice.accountId, "asset:test:eur"), 51_000n);
  assert.equal(verifier.lastCheckpoint().snapshotHash, s7.snapshotHash);
});
