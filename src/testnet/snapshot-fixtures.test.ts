/**
 * Golden snapshot fixtures (docs/COMPATIBILITY.md, ADR 0003). Every committed
 * fixture of every historical format is loaded on every run: migratable
 * formats must restore through the migration registry with the documented
 * results, unmigratable ones must be rejected with their documented reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { UepLedger, SNAPSHOT_FORMAT_VERSION, snapshotHash, type UepLedgerSnapshot } from "./ledger.ts";
import { deserializeTx } from "../core/transaction.ts";
import { Fr } from "../core/field.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { isLegacyAssetEncoding } from "../core/assets.ts";
import { reviveSnapshotBigints, snapshotFromJSON, snapshotToJSON } from "./snapshot-json.ts";
import {
  OLDEST_MIGRATABLE_SNAPSHOT_FORMAT,
  SNAPSHOT_MIGRATIONS,
  UNMIGRATABLE_SNAPSHOT_FORMATS,
  latestSnapshotFormat,
  migrateSnapshotPayload,
  migrationRegistryProblems,
  snapshotFormatSupport,
} from "./snapshot-migrations.ts";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "snapshots");
type Fixture = {
  label: string;
  formatVersion: number;
  trust: { authorities: string[]; faucetPublicKeys: string[] };
  accounts?: { alice: string; bob: string };
  historical: { assetIds: { eur: string; energy: string } };
  chain: UepLedgerSnapshot[];
  expectedRejection?: { code: string };
  expectedAfterMigration?: { formatVersion: number; height: number; txCount: number; mintCount: number; balances: Record<string, Record<string, string>> };
  postMigrationSpend?: { tx: any; expectedBalances: Record<string, Record<string, string>> };
};
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "FORMAT.json").sort();
const fixtures = files.map((f) => ({ file: f, fx: snapshotFromJSON<Fixture>(fs.readFileSync(path.join(DIR, f), "utf8")) }));
const clone = <T>(v: T): T => reviveSnapshotBigints(v);

function checkBalances(l: UepLedger, accounts: { alice: string; bob: string }, expected: Record<string, Record<string, string>>) {
  for (const [who, byAsset] of Object.entries(expected)) {
    for (const [asset, value] of Object.entries(byAsset)) {
      assert.equal(l.balanceOfAsset(new Fr(accounts[who as "alice" | "bob"]), asset).toString(), value, `${who} ${asset}`);
    }
  }
}

describe("golden snapshot fixtures", () => {
  it("cover every format from the oldest migratable one to the current one, and every registered step", () => {
    assert.deepEqual(migrationRegistryProblems(SNAPSHOT_FORMAT_VERSION), []);
    assert.equal(latestSnapshotFormat(), SNAPSHOT_FORMAT_VERSION);
    const formats = new Set(fixtures.map((f) => f.fx.formatVersion));
    for (let v = OLDEST_MIGRATABLE_SNAPSHOT_FORMAT; v <= SNAPSHOT_FORMAT_VERSION; v++) assert.ok(formats.has(v), `no fixture of format ${v}`);
    for (const step of SNAPSHOT_MIGRATIONS) {
      for (const f of step.fixtures) {
        const hit = fixtures.find((x) => x.file === f);
        assert.ok(hit, `step ${step.from}->${step.to}: fixture ${f} missing`);
        assert.equal(hit!.fx.formatVersion, step.from);
      }
    }
  });

  for (const { file, fx } of fixtures) {
    if (fx.expectedRejection) {
      it(`${file}: format ${fx.formatVersion} is rejected with its documented reason`, () => {
        const support = snapshotFormatSupport(fx.formatVersion);
        assert.equal(support.kind, "unmigratable");
        assert.ok(UNMIGRATABLE_SNAPSHOT_FORMATS[fx.formatVersion]);
        assert.throws(() => UepLedger.restoreChain(clone(fx.chain), fx.trust), (e: Error) => e.message.startsWith(`${fx.expectedRejection!.code}: `) && e.message.includes("Poseidon"));
      });
      continue;
    }
    it(`${file}: format ${fx.formatVersion} restores${fx.formatVersion === SNAPSHOT_FORMAT_VERSION ? "" : " through the migration registry"} with the documented values`, () => {
      const exp = fx.expectedAfterMigration!;
      const l = UepLedger.restoreChain(clone(fx.chain), fx.trust);
      assert.equal(l.restoredFrom?.formatVersion, fx.formatVersion);
      assert.deepEqual(l.restoredFrom?.migrationSteps, fx.formatVersion === SNAPSHOT_FORMAT_VERSION ? [] : SNAPSHOT_MIGRATIONS.filter((s) => s.from >= fx.formatVersion).map((s) => `${s.from}->${s.to}`));
      assert.equal(l.height, exp.height);
      const payload = l.snapshotPayload();
      assert.equal(payload.formatVersion, SNAPSHOT_FORMAT_VERSION);
      assert.equal(payload.txs.length, exp.txCount);
      assert.equal(payload.mints.length, exp.mintCount);
      assert.equal(payload.policy.windowHeights, 12);
      assert.equal((payload.policy as Record<string, unknown>).windowMs, undefined);
      // The chain continues from the snapshot as it was signed.
      const last = fx.chain[fx.chain.length - 1]!;
      assert.equal(payload.prevSnapshotHash, snapshotHash(last));
      assert.equal(payload.sequence, last.sequence + 1);
      checkBalances(l, fx.accounts!, exp.balances);
      // Each snapshot of the chain also restores on its own.
      assert.equal(UepLedger.restore(clone(fx.chain[0]!), fx.trust).restoredFrom?.formatVersion, fx.formatVersion);
    });

    it(`${file}: a spend signed after restore is accepted, including notes of pre-v0.5.0 asset ids`, () => {
      const l = UepLedger.restoreChain(clone(fx.chain), fx.trust);
      const tx = deserializeTx(clone(fx.postMigrationSpend!.tx));
      const legacy = fx.historical.assetIds.eur !== "uep-test/teur";
      assert.equal(isLegacyAssetEncoding(tx.assetId), legacy);
      assert.ok(tx.assetId.eq(encodeStringToFr(fx.historical.assetIds.eur)));
      const r = l.submit(tx);
      assert.ok("tx" in r, JSON.stringify((r as { error?: unknown }).error));
      checkBalances(l, fx.accounts!, fx.postMigrationSpend!.expectedBalances);
    });

    it(`${file}: signatures are checked on the snapshot as signed (a changed field fails before migration)`, () => {
      const chain = clone(fx.chain);
      (chain[0] as unknown as Record<string, unknown>).lastReconcileAt = 1;
      assert.throws(() => UepLedger.restore(chain[0]!, fx.trust), /INVALID_SNAPSHOT_HASH/);
      // The JSON codec keeps the hash (bigints are written as "<digits>n").
      const round = snapshotFromJSON<UepLedgerSnapshot>(snapshotToJSON(fx.chain[0]));
      assert.equal(snapshotHash(round), fx.chain[0]!.snapshotHash);
    });
  }

  it("migration steps are pure and deterministic and never touch transactions, mints or notes", () => {
    for (const { fx } of fixtures.filter((f) => f.fx.formatVersion < SNAPSHOT_FORMAT_VERSION && !f.fx.expectedRejection)) {
      const { snapshotHash: _h, signatures: _s, ...payload } = clone(fx.chain[1]!) as unknown as Record<string, unknown>;
      const before = snapshotToJSON(payload);
      const a = migrateSnapshotPayload(payload);
      const b = migrateSnapshotPayload(clone(payload));
      assert.equal(snapshotToJSON(payload), before, "input not mutated");
      assert.equal(snapshotToJSON(a.payload), snapshotToJSON(b.payload));
      for (const k of ["txs", "mints", "notes", "state", "nullifiers", "balances", "noteRoot"]) assert.equal(snapshotToJSON(a.payload[k]), snapshotToJSON(payload[k]), k);
      if (fx.formatVersion === 6) {
        assert.equal(a.payload.height, 0);
        assert.equal(a.payload.lastReconcileAt, 0);
      } else {
        assert.equal(a.payload.height, payload.height);
      }
      assert.equal(a.payload.assetRegistry, null);
    }
  });

  it("formats newer than this release or not integers are refused", () => {
    assert.equal(snapshotFormatSupport(SNAPSHOT_FORMAT_VERSION + 1).kind, "unknown");
    assert.equal(snapshotFormatSupport("7").kind, "unknown");
    const { fx } = fixtures.find((f) => f.fx.formatVersion === SNAPSHOT_FORMAT_VERSION)!;
    const future = clone(fx.chain[0]!) as unknown as Record<string, unknown>;
    future.formatVersion = SNAPSHOT_FORMAT_VERSION + 1;
    assert.throws(() => UepLedger.restore(future as unknown as UepLedgerSnapshot, fx.trust), new RegExp(`INVALID_SNAPSHOT_VERSION: snapshot formatVersion ${SNAPSHOT_FORMAT_VERSION + 1} is newer`));
  });
});
