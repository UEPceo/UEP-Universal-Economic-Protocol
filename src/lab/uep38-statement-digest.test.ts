import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { payloadDigest } from "./uep35-consensus-msg.ts";
import { p4SpendVoteBody, type SpendStatement } from "./uep38-p4-spend-cert.ts";

describe("statement binds parties; proof does not split the digest", () => {
  it("two proofs of the same payload share a digest, and the vote names recipient and treasury", () => {
    const base = { batchId: "b", amount: "1000", spendId: "uep-p4-lab|alice|n" };
    const a = payloadDigest(JSON.stringify({ ...base, zkSpend: "proof-A" }));
    const b = payloadDigest(JSON.stringify({ ...base, zkSpend: "proof-B" }));
    assert.equal(a, b);
    const statement: SpendStatement = {
      domainId: "uep-p4-lab", spendId: "uep-p4-lab|alice|n", oldRoot: "01", newRoot: "02",
      nullifier: "03", amount: "1000", fee: "1", senderId: "aa", recipientId: "bb", treasuryId: "cc", assetId: "dd",
    };
    const body = p4SpendVoteBody(statement);
    assert.equal(body.includes("bb"), true);
    assert.equal(body.includes("cc"), true);
    assert.equal(body.includes("proof"), false);
  });
});
