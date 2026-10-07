/**
 * v0.5.1: a snapshot survives a generic JSON round trip (bigints as tagged
 * objects, field elements as hex) and repeated restarts without changing a
 * byte of its payload. Transactions are serialized with canonical input and
 * output notes, and the transaction chain hash is computed over that form, so
 * the restored ledger re-derives the same roots and hashes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { UepLedger } from "./ledger.ts";
import { canonicalSerializedNote } from "../core/transaction.ts";
import { BN254_FR_MODULUS } from "../core/field.ts";
import { TESTNET } from "../network/profiles.ts";
import { generateEd25519KeyPair, stableStringify } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";

const S = generateEd25519KeyPair();
const F = generateEd25519KeyPair();
const TRUST = { authorities: [S.publicKeyHex], faucetPublicKeys: [F.publicKeyHex] };
const KEYS = { snapshotSigningKeys: [S.privateKey], faucetSigningKey: F.privateKey };

/** A generic disk codec of the kind an operator might use (not the repository's snapshotToJSON). */
const codec = <T>(x: T): T =>
  JSON.parse(
    JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v)),
    (_k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v),
  );
/** The payload without the fields that change on every snapshot (sequence, previous hash). */
const payloadOf = (l: UepLedger) => {
  const { sequence: _s, prevSnapshotHash: _p, ...rest } = l.snapshotPayload() as Record<string, unknown>;
  return stableStringify(rest);
};

test("snapshot: a JSON-codec round trip restores, and repeated restarts keep the payload byte-identical", async () => {
  const a = await identityFromMnemonic(await generateMnemonic(128)); // in memory only
  const b = await identityFromMnemonic(await generateMnemonic(128));
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, ...KEYS });
  ledger.faucet(ledger.addressOf(a.accountId), "uep-test/teur", 100_000n);
  for (const authorization of ["sender-signature", "development-mac"] as const) {
    ledger.advanceHeight(1);
    const p = ledger.prepareSpend(a, ledger.addressOf(b.accountId), "uep-test/teur", 1_000n, undefined, { authorization });
    assert.ok("tx" in p);
    const r = authorization === "development-mac" ? ledger.submit(p.tx, a) : ledger.submit(p.tx);
    assert.ok("tx" in r, JSON.stringify((r as { error?: unknown }).error));
  }
  const reference = payloadOf(ledger);
  let current = ledger;
  for (let restart = 0; restart < 4; restart++) {
    const restored = UepLedger.restore(codec(current.snapshot()), TRUST, KEYS);
    assert.equal(payloadOf(restored), reference, `restart ${restart}`);
    assert.equal(restored.height, ledger.height);
    current = restored;
  }
  // The restored ledger keeps working: a spend after the last restart is accepted.
  current.advanceHeight(1);
  const after = current.prepareSpend(a, current.addressOf(b.accountId), "uep-test/teur", 10n);
  assert.ok("tx" in after);
  assert.ok("tx" in current.submit(after.tx));
});

test("canonical notes: non-canonical field elements and a non-boolean `spent` are refused, not reduced", () => {
  const ok = { assetId: "0x05", amount: "7", owner: "0x01", blinding: "0x02", commitment: "0x03", nonce: "0x04", spent: false };
  assert.equal(canonicalSerializedNote(ok).assetId, canonicalSerializedNote({ ...ok, assetId: 5n }).assetId);
  const rPlus5 = "0x" + (BN254_FR_MODULUS + 5n).toString(16);
  assert.throws(() => canonicalSerializedNote({ ...ok, assetId: rPlus5 }), /TX_NOTE_INVALID: field element is not canonical/);
  assert.throws(() => canonicalSerializedNote({ ...ok, owner: BN254_FR_MODULUS }), /TX_NOTE_INVALID/);
  assert.throws(() => canonicalSerializedNote({ ...ok, blinding: "0xzz" }), /TX_NOTE_INVALID/);
  assert.throws(() => canonicalSerializedNote({ ...ok, spent: "no" }), /TX_NOTE_INVALID: spent is a boolean/);
  assert.equal(canonicalSerializedNote({ ...ok, spent: undefined }).spent, undefined);
  // v0.5.3: a negative bigint amount is refused like its string form.
  assert.throws(() => canonicalSerializedNote({ ...ok, amount: -1n }), /TX_NOTE_INVALID/);
  assert.throws(() => canonicalSerializedNote({ ...ok, amount: "-1" }), /TX_NOTE_INVALID/);
  assert.equal(canonicalSerializedNote({ ...ok, amount: 0n }).amount, "0");
});
