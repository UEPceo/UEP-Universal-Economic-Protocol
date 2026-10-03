import assert from "node:assert/strict";
import { test } from "node:test";
import { Fr } from "../core/field.ts";
import { hAccount, hTx } from "../core/hash.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";

test("public hash is ordered and not the old commutative algebraic placeholder", () => {
  const a = new Fr(123n);
  const b = new Fr(456n);
  assert.notEqual(hTx(a, b).toHex(), hTx(b, a).toHex());
  assert.notEqual(hAccount(new Fr(1n), new Fr(2n)).toHex(), hAccount(new Fr(2n), new Fr(1n)).toHex());
});

test("forged accountId without the secret cannot spend", async () => {
  const owner = await identityFromMnemonic(await generateMnemonic(128));
  const attacker = await identityFromMnemonic(await generateMnemonic(128));
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  ledger.faucet(owner.accountId, "uep-test/teur", 500_000n);
  const forged = { ...attacker, accountId: owner.accountId };
  const prepared = ledger.prepareSpend(forged, attacker.accountId, "uep-test/teur", 400_000n);
  assert.equal("error" in prepared, true);
});

test("submit requires sender authentication by default and cannot bypass policy", async () => {
  const owner = await identityFromMnemonic(await generateMnemonic(128));
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  ledger.faucet(owner.accountId, "uep-test/teur", 500_000n);
  // Local development MAC: without the sender identity there is no proof.
  const mac = ledger.prepareSpend(owner, recipient.accountId, "uep-test/teur", 100_000n, ledger.height, { authorization: "development-mac" });
  assert.ok("tx" in mac);
  if (!("tx" in mac)) return;
  const noSecret = ledger.submit(mac.tx);
  assert.equal("error" in noSecret, true);
  if ("error" in noSecret) assert.equal(noSecret.error.code, "PROOF");
  // Default (v0.5.0): sender-signature spend, verified without secrets.
  const prepared = ledger.prepareSpend(owner, recipient.accountId, "uep-test/teur", 100_000n);
  assert.ok("tx" in prepared);
  if (!("tx" in prepared)) return;
  ledger.policy.setPaused(true);
  const paused = ledger.submit(prepared.tx, owner);
  assert.equal("error" in paused, true);
  if ("error" in paused) assert.equal(paused.error.code, "POLICY");
});

test("input value is bound to the amount plus fee", async () => {
  const owner = await identityFromMnemonic(await generateMnemonic(128));
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  ledger.faucet(owner.accountId, "uep-test/teur", 1n);
  const prepared = ledger.prepareSpend(owner, recipient.accountId, "uep-test/teur", 2n);
  assert.equal("error" in prepared, true);
});

test("snapshot and restore are executable", async () => {
  const owner = await identityFromMnemonic(await generateMnemonic(128));
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  ledger.faucet(owner.accountId, "uep-test/teur", 500n);
  const snap = ledger.snapshot();
  // Verifiers only need the public keys.
  const restored = UepLedger.restore(snap, { authorities: ledger.snapshotAuthorityPublicKeys(), faucetPublicKeys: [ledger.faucetPublicKey()!] });
  assert.equal(restored.stateRoot().toHex(), ledger.stateRoot().toHex());
  assert.equal(restored.balanceOf(owner.accountId, encodeStringToFr("uep-test/teur")), 500n);
});

test("domain separation changes transaction commitments", async () => {
  const owner = await identityFromMnemonic(await generateMnemonic(128));
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const a = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  const b = new UepLedger({ networkId: TESTNET.networkId, domainId: "MARS", connected: true, allowFaucet: true });
  a.faucet(owner.accountId, "uep-test/teur", 500n);
  b.faucet(owner.accountId, "uep-test/teur", 500n);
  const pa = a.prepareSpend(owner, recipient.accountId, "uep-test/teur", 100n);
  const pb = b.prepareSpend(owner, recipient.accountId, "uep-test/teur", 100n);
  assert.ok("tx" in pa && "tx" in pb);
  if ("tx" in pa && "tx" in pb) assert.notEqual(pa.tx.txId.toHex(), pb.tx.txId.toHex());
});
