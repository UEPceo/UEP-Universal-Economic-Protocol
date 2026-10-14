import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { Fr } from "../core/field.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";

test("two replicas record the same faucet note when the client supplies the opening", async () => {
  const faucet = generateEd25519KeyPair();
  const snap = generateEd25519KeyPair();
  const opts = { networkId: "uep-testnet-1", domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey };
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const opening = new Fr(42n);
  const left = new UepLedger(opts as never);
  const right = new UepLedger(opts as never);
  const n1 = left.faucet(a.accountId, "uep-test/teur", 1000n, opening);
  const n2 = right.faucet(a.accountId, "uep-test/teur", 1000n, opening);
  assert.equal(n1.commitment.toHex(), n2.commitment.toHex());
  assert.equal(left.stateRoot().toHex(), right.stateRoot().toHex());
  assert.throws(() => left.faucet(a.accountId, "uep-test/teur", 1000n, opening), /CLIENT_NOTE_DUPLICATE/);
});
