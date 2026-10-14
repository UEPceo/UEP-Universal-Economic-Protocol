import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";

test("a faucet rotation needs both keys in trust: the old mint and the new one", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const oldFaucet = generateEd25519KeyPair();
  const nextFaucet = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fee = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const node = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey: oldFaucet });
  node.ledger.faucet(buyer.accountId, "uep-test/teur", 10n, clientBlinding(1n));
  node.ledger.rotateFaucetKey(nextFaucet.privateKey);
  node.ledger.faucet(buyer.accountId, "uep-test/teur", 10n, clientBlinding(2n));
  const snap = node.ledger.snapshot();
  const base = { authorities: [snapshotKey.publicKeyHex] };
  assert.throws(() => UepLedger.restore(snap, { ...base, faucetPublicKeys: [oldFaucet.publicKeyHex] }), /MINT/);
  assert.throws(() => UepLedger.restore(snap, { ...base, faucetPublicKeys: [nextFaucet.publicKeyHex] }), /MINT/);
  assert.doesNotThrow(() => UepLedger.restore(snap, { ...base, faucetPublicKeys: [oldFaucet.publicKeyHex, nextFaucet.publicKeyHex] }));
});
