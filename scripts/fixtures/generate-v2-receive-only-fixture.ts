/**
 * Generate the v2 receive-only wallet fixture (public data only):
 *
 *   git archive 8d774d3 src | tar -x -C /tmp/fx/8d774d3
 *   node --experimental-strip-types scripts/fixtures/generate-v2-receive-only-fixture.ts \
 *     --legacy-src /tmp/fx/8d774d3/src --commit 8d774d3 \
 *     --out src/identity/fixtures/v2-receive-only-v0.5.0.json
 *
 * The historical code (v0.5.0, v2 account ids) pays two notes to a v2
 * account that never spends. That account is derived from the public BIP39
 * test-vector mnemonic ("abandon" x 11 + "about"), which is published in the
 * BIP39 specification and must never hold value: it is test data, not a key.
 * The snapshot authority, the faucet key and the payer are generated in
 * memory and discarded.
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
const out = path.resolve(arg("out"));
const currentSrc = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src");
const imp = (root: string, rel: string) => import(pathToFileURL(path.join(root, rel)).href);

/** Public BIP39 test vector (all-zero entropy). Test data only; never a key for value. */
export const PUBLIC_TEST_VECTOR_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

async function main() {
  const L = await imp(legacySrc, "testnet/ledger.ts");
  const I = await imp(legacySrc, "identity/index.ts");
  const E = await imp(legacySrc, "core/ed25519.ts");
  const P = await imp(legacySrc, "network/profiles.ts");
  const networkId = P.TESTNET.networkId as string;
  const authority = E.generateEd25519KeyPair();
  const faucet = E.generateEd25519KeyPair();
  const payer = await I.identityFromMnemonic(await I.generateMnemonic(128));
  const receiveOnly = await I.identityFromMnemonic(PUBLIC_TEST_VECTOR_MNEMONIC);
  const ledger = new L.UepLedger({ networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [authority.privateKey], faucetSigningKey: faucet.privateKey });
  const pay = (amount: bigint) => {
    const p = ledger.prepareSpend(payer, receiveOnly.accountId, "uep-test/teur", amount);
    if (!("tx" in p)) throw new Error(JSON.stringify(p.error));
    const r = ledger.submit(p.tx);
    if ("error" in r) throw new Error(JSON.stringify(r.error));
  };
  ledger.faucet(payer.accountId, "uep-test/teur", 1_000_000n);
  pay(300_000n);
  pay(200_000n);
  const snap = ledger.snapshot();
  const J = await imp(currentSrc, "testnet/snapshot-json.ts");
  const chain = J.snapshotFromJSON(J.snapshotToJSON([snap]));
  const fixture = {
    fixture: "uep-v2-receive-only-wallet",
    sourceCommit: commit,
    formatVersion: chain[0].formatVersion,
    note: "Public data only. The receive-only account is derived from the public BIP39 test-vector mnemonic (test data, never a key for value); every other key was generated in memory and discarded.",
    networkId,
    trust: { authorities: [authority.publicKeyHex], faucetPublicKeys: [E.publicKeyHexOf(faucet.publicKey)] },
    receiveOnly: { v2AccountId: receiveOnly.accountId.toHex(), balance: "500000", notes: 2 },
    chain,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 1) + "\n");
  console.log(`wrote ${out} (format ${fixture.formatVersion})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
