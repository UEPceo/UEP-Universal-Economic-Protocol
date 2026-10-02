import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateMnemonic, mnemonicToEntropy, mnemonicToSeed } from "./mnemonic.ts";
import { deriveIdentity } from "./kdf.ts";
import { accountIdFromSpendKey, deriveSpendKey } from "../core/spend-key.ts";
import { BIP39_ENGLISH } from "./bip39-english.ts";

describe("BIP39 identity", () => {
  it("roundtrips entropy and derives a stable account id", async () => {
    const m = await generateMnemonic(128);
    assert.equal(m.split(" ").length, 12);
    await mnemonicToEntropy(m);
    const seed = await mnemonicToSeed(m);
    const id = await deriveIdentity(seed, m);
    // v0.4.5: the account id commits to the deterministic spend key (UEP-ADDR-002).
    assert.equal(deriveSpendKey(id.secret, id.salt).publicKeyHex, id.spendPublicKey);
    assert.ok(accountIdFromSpendKey(id.spendPublicKey).eq(id.accountId));
    const id2 = await deriveIdentity(seed, m);
    assert.ok(id.accountId.eq(id2.accountId));
  });

  it("rejects a corrupted checksum", async () => {
    const m = await generateMnemonic(128);
    const words = m.split(" ");
    // Flip the lowest bit of the last word index: for 12 words that bit is a
    // checksum bit only (entropy unchanged), so the checksum is always invalid.
    words[11] = BIP39_ENGLISH[BIP39_ENGLISH.indexOf(words[11]) ^ 1];
    await assert.rejects(() => mnemonicToEntropy(words.join(" ")));
  });
});
