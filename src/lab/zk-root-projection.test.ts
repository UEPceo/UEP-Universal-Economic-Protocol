/**
 * v0.5.3 crypto alignment: the circuit-depth projection of the ledger state
 * tree (src/core/zk-tx-adapter.ts) gives the same leaves, slots and root as
 * the UEP-26 Rust code (`uep-zk note-commit`, `state-index`, `smt-root 32`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { Fr } from "../core/field.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { ledgerAssetIdToFr } from "../core/assets.ts";
import { CIRCUIT_TREE_DEPTH, circuitBalanceLeaf, circuitSlotIndex, ledgerBalanceKey, ledgerBalanceLeaf } from "../core/zk-tx-adapter.ts";
import { padFrHex, runUepZk, zkNoteCommit, zkSmtRoot } from "./uep-zk-runner.ts";

const EUR = "uep-test/teur";

test("projected ledger roots at depth 32 equal uep-zk smt-root over circuit leaves", async () => {
  const FAUCET = generateEd25519KeyPair();
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, faucetSigningKey: FAUCET.privateKey });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, EUR, 10_000n);
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  assert.ok("tx" in l.submit(p.tx));
  const asset = ledgerAssetIdToFr(EUR);
  const accounts = [a.accountId, b.accountId, TREASURY_ID];
  const amounts = accounts.map((x) => l.balanceOf(x, asset));
  assert.ok(amounts.every((x) => x > 0n));
  const leaves: Array<{ index: bigint; leafHex: string }> = [];
  for (const [i, a] of accounts.entries()) {
    const leaf = circuitBalanceLeaf(ledgerBalanceLeaf(a, asset, amounts[i]!));
    // Leaf: circuit note_commitment(owner, asset, amount, blinding 0).
    assert.equal(padFrHex(leaf.toHex()), zkNoteCommit(a.toHex(), asset.toHex(), Fr.from(amounts[i]!).toHex(), "0"));
    // Slot: circuit state_index(account, asset, 32).
    const r = runUepZk(["state-index", padFrHex(a.toHex()), padFrHex(asset.toHex()), String(CIRCUIT_TREE_DEPTH)]);
    assert.ok(r.ok, r.stderr);
    const slot = circuitSlotIndex(ledgerBalanceKey(a, asset));
    assert.equal(r.stdout.match(/index=(\d+)/)?.[1], slot.toString());
    leaves.push({ index: slot, leafHex: leaf.toHex() });
  }
  const projected = l.zkCircuitProjection().state.root();
  assert.equal(padFrHex(projected.toHex()), zkSmtRoot(CIRCUIT_TREE_DEPTH, leaves));
  const nf = p.tx.nullifier;
  assert.equal(padFrHex(l.zkCircuitProjection().nullifiers.root().toHex()), zkSmtRoot(CIRCUIT_TREE_DEPTH, [{ index: nf.lowBits(CIRCUIT_TREE_DEPTH), leafHex: nf.toHex() }]));
});
