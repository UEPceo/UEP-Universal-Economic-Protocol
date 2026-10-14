import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";

test("a rotated snapshot key signs the next snapshot, and the old key no longer does", async () => {
  const oldKey = generateEd25519KeyPair();
  const nextKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fee = await identityFromMnemonic(await generateMnemonic(128));
  const node = assembleNode({ custody, feeAccount: fee, snapshotKey: oldKey, faucetKey });
  const first = node.ledger.snapshot();
  node.ledger.rotateSnapshotSigners([nextKey.privateKey]);
  const second = node.ledger.snapshot();
  const trustOld = { authorities: [oldKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const trustNext = { authorities: [nextKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  assert.equal(UepLedger.restore(first, trustOld).height, node.ledger.height);
  assert.throws(() => UepLedger.restore(second, trustOld), /INVALID_SNAPSHOT/);
  assert.equal(UepLedger.restore(second, trustNext).height, node.ledger.height);
});
