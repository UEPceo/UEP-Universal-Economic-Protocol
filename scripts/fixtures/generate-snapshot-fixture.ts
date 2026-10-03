/**
 * Generate a golden ledger-snapshot fixture from a historical source tree
 * (docs/COMPATIBILITY.md). Run once per historical snapshot format and commit
 * the JSON output; tests load every fixture on every run.
 *
 *   git archive <commit> src | tar -x -C /tmp/fx/<commit>
 *   node --experimental-strip-types scripts/fixtures/generate-snapshot-fixture.ts \
 *     --legacy-src /tmp/fx/<commit>/src --commit <commit> --label <label> \
 *     --out src/testnet/fixtures/snapshots/<label>.json
 *
 * Phase 1 runs the historical code: two snapshots of a small ledger (faucet
 * mints, a spend in each direction, a reconcile that stores that release's
 * `lastReconcileAt`). Phase 2 runs the current code: it restores the chain
 * through the migration registry and builds one signed spend that the test
 * submits after restore (a spend needs the owner's key only at signing time).
 *
 * Every key (snapshot authority, faucet, account identities) is generated in
 * memory and discarded at exit. The fixture holds public data only: signed
 * snapshots, public keys, one signed transaction and expected values.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
}

const legacySrc = path.resolve(arg("legacy-src"));
const commit = arg("commit");
const label = arg("label");
const out = path.resolve(arg("out"));
const currentSrc = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src");

const imp = (root: string, rel: string) => import(pathToFileURL(path.join(root, rel)).href);

async function main() {
  // ---- Phase 1: historical code ----
  const L = await imp(legacySrc, "testnet/ledger.ts");
  const I = await imp(legacySrc, "identity/index.ts");
  const E = await imp(legacySrc, "core/ed25519.ts");
  const A = await imp(legacySrc, "core/assets.ts");
  const P = await imp(legacySrc, "network/profiles.ts");
  const networkId = P.TESTNET.networkId as string;
  const eur = A.findAsset(networkId, "uep-test/teur") ? "uep-test/teur" : "asset:test:eur";
  const energy = A.findAsset(networkId, "uep-test/tenergy") ? "uep-test/tenergy" : "asset:test:energy";

  const authority = E.generateEd25519KeyPair();
  const faucet = E.generateEd25519KeyPair();
  const mnemonics = [await I.generateMnemonic(128), await I.generateMnemonic(128)];
  const alice = await I.identityFromMnemonic(mnemonics[0]);
  const bob = await I.identityFromMnemonic(mnemonics[1]);
  const ledger = new L.UepLedger({ networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [authority.privateKey], faucetSigningKey: faucet.privateKey });

  const submit = (prepared: any, secrets: any) => {
    if (!("tx" in prepared)) throw new Error(`prepare: ${JSON.stringify(prepared.error)}`);
    let r = ledger.submit(prepared.tx);
    if ("error" in r) r = ledger.submit(prepared.tx, secrets);
    if ("error" in r) throw new Error(`submit: ${JSON.stringify(r.error)}`);
  };
  // Formats with a block height (7+): advance it between steps so the fixture carries non-zero heights.
  const advance = (n: number) => { if (typeof ledger.advanceHeight === "function") ledger.advanceHeight(n); };
  ledger.faucet(alice.accountId, eur, 1_000_000n);
  advance(2);
  ledger.faucet(alice.accountId, energy, 500n);
  submit(ledger.prepareSpend(alice, bob.accountId, eur, 250_000n), alice);
  advance(3);
  ledger.reconcilePending();
  const snap1 = ledger.snapshot();
  advance(5);
  submit(ledger.prepareSpend(bob, alice.accountId, eur, 1_000n), bob);
  ledger.reconcilePending();
  const snap2 = ledger.snapshot();
  const J = await imp(currentSrc, "testnet/snapshot-json.ts");
  const chain = J.snapshotFromJSON(J.snapshotToJSON([snap1, snap2]));
  const formatVersion = chain[1].formatVersion;
  const historical = {
    assetIds: { eur, energy },
    lastReconcileAt: chain[1].lastReconcileAt,
    balances: {
      alice: { eur: String(ledger.balanceOf(alice.accountId, A.ledgerAssetIdToFr ? A.ledgerAssetIdToFr(eur) : undefined)), energy: String(ledger.balanceOf(alice.accountId, A.ledgerAssetIdToFr(energy))) },
      bob: { eur: String(ledger.balanceOf(bob.accountId, A.ledgerAssetIdToFr(eur))) },
    },
  };

  // ---- Phase 2: current code (migration + one post-migration spend) ----
  const CL = await imp(currentSrc, "testnet/ledger.ts");
  const CI = await imp(currentSrc, "identity/index.ts");
  const CT = await imp(currentSrc, "core/transaction.ts");
  const trust = { authorities: [authority.publicKeyHex], faucetPublicKeys: [E.publicKeyHexOf(faucet.publicKey)] };
  if (process.argv.includes("--expect-unmigratable")) {
    let message = "";
    try { CL.UepLedger.restoreChain(chain, trust); } catch (e) { message = (e as Error).message; }
    if (!message.startsWith("INVALID_SNAPSHOT_VERSION")) throw new Error(`expected INVALID_SNAPSHOT_VERSION, got ${message || "a restored ledger"}`);
    const fixture = { fixture: "uep-ledger-snapshot-chain", label, sourceCommit: commit, formatVersion, note: NOTE, networkId, trust, historical, chain, expectedRejection: { code: "INVALID_SNAPSHOT_VERSION", message } };
    write(fixture, formatVersion, chain.length, eur, energy);
    return;
  }
  const restored = CL.UepLedger.restoreChain(chain, trust);
  const aliceNow = await CI.identityFromMnemonic(mnemonics[0]);
  const bobNow = await CI.identityFromMnemonic(mnemonics[1]);
  const prepared = restored.prepareSpend(aliceNow, bobNow.accountId, "uep-test/teur", 10_000n);
  if (!("tx" in prepared)) throw new Error(`post-migration prepare: ${JSON.stringify(prepared.error)}`);
  const postMigrationSpend = JSON.parse(JSON.stringify(CT.serializeTx(prepared.tx)));
  const applied = restored.submit(prepared.tx);
  if ("error" in applied) throw new Error(`post-migration submit: ${JSON.stringify(applied.error)}`);
  const bal = (id: any, asset: string) => String(restored.balanceOfAsset(id, asset));

  const fixture = {
    fixture: "uep-ledger-snapshot-chain",
    label,
    sourceCommit: commit,
    formatVersion,
    note: NOTE,
    networkId,
    trust,
    accounts: { alice: aliceNow.accountId.toHex(), bob: bobNow.accountId.toHex() },
    historical,
    chain,
    expectedAfterMigration: {
      formatVersion: CL.SNAPSHOT_FORMAT_VERSION,
      height: restored.height,
      txCount: chain[1].txs.length,
      mintCount: chain[1].mints.length,
      balances: {
        alice: { "uep-test/teur": historical.balances.alice.eur, "uep-test/tenergy": historical.balances.alice.energy },
        bob: { "uep-test/teur": historical.balances.bob.eur },
      },
    },
    postMigrationSpend: {
      tx: postMigrationSpend,
      expectedBalances: { alice: { "uep-test/teur": bal(aliceNow.accountId, "uep-test/teur") }, bob: { "uep-test/teur": bal(bobNow.accountId, "uep-test/teur") } },
    },
  };
  write(fixture, formatVersion, chain.length, eur, energy);
}

const NOTE = "Golden fixture (public data only). Keys and mnemonics were generated in memory by scripts/fixtures/generate-snapshot-fixture.ts and discarded.";

function write(fixture: unknown, formatVersion: number, n: number, eur: string, energy: string) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 1) + "\n");
  console.log(`wrote ${out} (format ${formatVersion}, ${n} snapshots, assets ${eur}, ${energy})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
