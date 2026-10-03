import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { encodeStringToFr, noteCommitment } from "../core/index.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { UepAddressV2 } from "../core/address.ts";
import { hAccount } from "../core/hash.ts";

async function twoIdentities() {
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  assert.equal(a.accountId.eq(b.accountId), false);
  return { a, b };
}

function testnetLedger() {
  return new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
}

describe("UEP public testnet", () => {
  it("create / faucet / send / receive", async () => {
    const { a, b } = await twoIdentities();
    const node = testnetLedger();
    node.faucet(a.accountId, "uep-test/teur", 250_000n);
    const p = node.prepareSpend(a, b.accountId, "uep-test/teur", 100_000n);
    assert.ok("tx" in p);
    if (!("tx" in p)) return;
    const s = node.submit(p.tx, a);
    assert.ok("tx" in s);
    assert.equal(node.balanceOf(b.accountId, encodeStringToFr("uep-test/teur")), 100_000n);
  });

  it("replay and double spend are rejected", async () => {
    const { a, b } = await twoIdentities();
    const node = testnetLedger();
    node.faucet(a.accountId, "uep-test/teur", 50_000n);
    const p = node.prepareSpend(a, b.accountId, "uep-test/teur", 10_000n);
    assert.ok("tx" in p);
    if (!("tx" in p)) return;
    assert.ok("tx" in node.submit(p.tx, a));
    const again = node.submit(p.tx, a);
    assert.ok("error" in again);
    if ("error" in again) assert.equal(again.error.code, "REPLAY");
  });

  it("wrong owner and amount mutation are rejected", async () => {
    const { a, b } = await twoIdentities();
    const node = testnetLedger();
    const note = node.faucet(a.accountId, "uep-test/teur", 50_000n);
    const wrong = node.prepareSpend(b, a.accountId, "uep-test/teur", 10_000n);
    assert.ok("error" in wrong);
    const p = node.prepareSpend(a, b.accountId, "uep-test/teur", 10_000n);
    assert.ok("tx" in p);
    if (!("tx" in p)) return;
    const mutated = { ...p.tx, amount: 99_000n };
    assert.ok("error" in node.submit(mutated, a));
    assert.equal(noteCommitment(note.owner, note.assetId, 9_000n, note.blinding).eq(note.commitment), false);
  });

  it("network isolation is encoded in addresses", async () => {
    const { a } = await twoIdentities();
    const test = testnetLedger();
    test.faucet(a.accountId, "uep-test/teur", 1_000n);
    const addrT = UepAddressV2.encode(test.networkId, a.accountId);
    const addrOther = UepAddressV2.encode("uep-global-1", a.accountId);
    assert.notEqual(addrT, addrOther);
    // v0.4.5: the network tag is checksummed into the address.
    assert.ok(UepAddressV2.decode(addrT, test.networkId)?.accountId.eq(a.accountId));
    assert.equal(UepAddressV2.decode(addrOther, test.networkId), null);
    assert.equal(test.addressOf(a.accountId), addrT);
    assert.ok(hAccount(new Fr(123456789n), new Fr(1n)).eq(hAccount(new Fr(123456789n), new Fr(1n))));
  });
});
