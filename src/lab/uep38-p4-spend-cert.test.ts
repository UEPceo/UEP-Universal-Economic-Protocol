import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateP4Bootstrap } from "./uep38-p4-process-node.ts";
import { BN254_FR, canonicalFieldHex, identityFromBoot, p4SpendVoteBody, signP4Spend, verifyP4SpendCert, type SpendStatement } from "./uep38-p4-spend-cert.ts";

describe("spend statement ignores proof randomization", () => {
  it("two proof hashes do not change the vote, and an alias field is rejected", () => {
    const boot = generateP4Bootstrap(4);
    const pub = new Map(boot.nodes.map((n) => [n.id, n.publicKeyHex]));
    const ids = boot.nodes.map((n) => identityFromBoot(n.id, n.privateKeyHex!, n.publicKeyHex));
    const statement: SpendStatement = {
      domainId: "uep-p4-lab",
      spendId: "uep-p4-lab|alice|n1",
      oldRoot: "01".repeat(32),
      newRoot: "02".repeat(32),
      nullifier: "03".repeat(32),
      amount: "1000",
      fee: "1",
      senderId: "aa",
      recipientId: "bb",
      treasuryId: "cc",
      assetId: "dd",
    };
    assert.equal(p4SpendVoteBody(statement), p4SpendVoteBody(statement));
    assert.equal(p4SpendVoteBody(statement).includes("proof"), false);
    const votes = ids.slice(0, 3).map((id) => signP4Spend(id, statement));
    assert.equal(verifyP4SpendCert(pub, { ...statement, votes }).ok, true);
    const otherProofWouldHaveChangedOldBody = "ff".repeat(64);
    assert.equal(p4SpendVoteBody(statement).includes(otherProofWouldHaveChangedOldBody), false);
    assert.equal(canonicalFieldHex("01".repeat(32)).ok, true);
    assert.equal(canonicalFieldHex(BN254_FR.toString(16)).ok, false);
  });
});
