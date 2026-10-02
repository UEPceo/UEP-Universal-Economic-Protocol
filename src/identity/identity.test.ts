import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateMnemonic, mnemonicToEntropy, mnemonicToSeed } from "./mnemonic.ts";
import { deriveIdentity } from "./kdf.ts";
import { hAccount } from "../core/hash.ts";

describe("BIP39 identity", () => {
  it("roundtrips entropy and derives a stable account id", async () => {
    const m = await generateMnemonic(128);
    assert.equal(m.split(" ").length, 12);
    await mnemonicToEntropy(m);
    const seed = await mnemonicToSeed(m);
    const id = await deriveIdentity(seed, m);
    assert.ok(hAccount(id.secret, id.salt).eq(id.accountId));
    const id2 = await deriveIdentity(seed, m);
    assert.ok(id.accountId.eq(id2.accountId));
  });

  it("rejects a corrupted checksum", async () => {
    const m = await generateMnemonic(128);
    const words = m.split(" ");
    words[11] = words[11] === "zoo" ? "abandon" : "zoo";
    await assert.rejects(() => mnemonicToEntropy(words.join(" ")));
  });
});
