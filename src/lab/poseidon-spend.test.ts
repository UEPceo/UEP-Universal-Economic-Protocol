import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { findUepZkBinary, zkProveSpendJson, zkVerifyHex } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";

describe("poseidon spend request JSON", () => {
  it("builds valid request shape", () => {
    const req = buildPoseidonSpendRequest({
      depth: 4,
      senderSecret: Fr.from(11n),
      senderSalt: Fr.from(22n),
      recipientId: Fr.from(33n),
      treasuryId: Fr.from(44n),
      assetId: Fr.from(1n),
      amount: 1000n,
      senderOldBalance: 10_000n,
      noteBlinding: Fr.from(3n),
      recipientBlinding: Fr.from(4n),
      treasuryBlinding: Fr.from(5n),
    });
    assert.equal(String(req.amount), "1000");
    assert.equal(String(req.fee), String(creatorFee(1000n)));
    assert.equal(req.depth, 4);
  });

  it("prove-spend-json binds publics (needs uep-zk)", () => {
    assert.ok(
      findUepZkBinary(),
      "uep-zk binary required — no SKIP allowed in UEP-29.4 (scripts/build-uep-zk.sh)",
    );
    const req = buildPoseidonSpendRequest({
      depth: 4,
      senderSecret: Fr.from(11n),
      senderSalt: Fr.from(22n),
      recipientId: Fr.from(33n),
      treasuryId: Fr.from(44n),
      assetId: Fr.from(1n),
      amount: 1000n,
      senderOldBalance: 10_000n,
      noteBlinding: Fr.from(3n),
      recipientBlinding: Fr.from(4n),
      treasuryBlinding: Fr.from(5n),
    });
    const art = zkProveSpendJson(req);
    assert.equal(art.ok, true, art.error ?? art.raw);
    assert.equal(art.publicInputsHex.length, 13); // 12 economic publics + domain_id (UEP-38.34)
    const v = zkVerifyHex(art.vkHex!, art.proofHex!, art.publicInputsHex);
    assert.equal(v.ok, true, v.raw);
    // Tamper amount public → reject
    const bad = [...art.publicInputsHex];
    bad[8] = "00".repeat(32);
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, bad).ok, false);
  });
});
