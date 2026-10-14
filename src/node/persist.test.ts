import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { clientBlinding } from "../core/client-note.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";

test("a signed snapshot reopens the same custody balance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uep-node-"));
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const node = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 99n });
  node.ledger.faucet(custody.accountId, "uep-test/teur", 40n, clientBlinding(7n));
  writeFileSync(join(dir, "ledger.snapshot.json"), JSON.stringify(node.ledger.snapshot(), (_k, v) => typeof v === "bigint" ? { $b: v.toString() } : v));
  writeFileSync(join(dir, "marketplace.snapshot.json"), JSON.stringify(node.marketplace.exportSnapshot(), (_k, v) => typeof v === "bigint" ? v.toString() : v));
  const restored = UepLedger.restore(JSON.parse(readFileSync(join(dir, "ledger.snapshot.json"), "utf8"), (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v), {
    authorities: [snapshotKey.publicKeyHex],
    faucetPublicKeys: [faucetKey.publicKeyHex],
  }, { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey });
  assert.equal(restored.height, node.ledger.height);
  const again = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 99n, ledger: restored, marketplaceSnapshot: JSON.parse(readFileSync(join(dir, "marketplace.snapshot.json"), "utf8")) });
  assert.equal(again.ledger.height, node.ledger.height);
});
