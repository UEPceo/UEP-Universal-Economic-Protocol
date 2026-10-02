import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import {
  publicInputsFromHex,
  publicInputsToHex,
  reconcileProofPublicInputs,
  assertProofBindsTxFields,
  diffPublicInputHex,
  normalizeFrHex,
} from "./zk-public-inputs.ts";
import type { SpendPublicInputs } from "../core/spend-proof.ts";
import type { ZkSpendProof } from "./zk-spend-provider.ts";
import {
  verifyZkSpendProofAgainstExpected,
  PoseidonWalletProvider,
} from "./zk-spend-provider.ts";
import { findUepZkBinary, zkProveSpendJson, zkVerifyHex } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";
import { hAccount } from "../core/hash.ts";
import {
  buildStructuralZkSpendInstance,
  defaultBalanceLeaf,
} from "../core/zk-witness-contract.ts";
import { SparseMerkleTree } from "../core/smt.ts";

function samplePub(): SpendPublicInputs {
  return {
    oldStateRoot: Fr.from(1n),
    newStateRoot: Fr.from(2n),
    oldNullifierRoot: Fr.from(3n),
    newNullifierRoot: Fr.from(4n),
    senderId: Fr.from(5n),
    recipientId: Fr.from(6n),
    treasuryId: Fr.from(7n),
    assetId: Fr.from(8n),
    amount: Fr.from(1000n),
    fee: Fr.from(1n),
    nullifier: Fr.from(9n),
    transactionCommitment: Fr.from(10n),
  };
}

describe("UEP-28.7 public input binding", () => {
  it("reconcile forces publicInputs from hex", () => {
    const pub = samplePub();
    const hex = publicInputsToHex(pub);
    const wrong: SpendPublicInputs = { ...pub, amount: Fr.from(999n) };
    const proof: ZkSpendProof = {
      kind: "zk-spend",
      protocolVersion: "t",
      circuitTag: "t",
      publicInputs: wrong,
      publicInputsHex: hex,
      backend: "test",
    };
    const rec = reconcileProofPublicInputs(proof);
    assert.equal(rec.publicInputs.amount.n, 1000n);
    assert.equal(diffPublicInputHex(publicInputsToHex(rec.publicInputs), hex).length, 0);
  });

  it("assertProofBindsTxFields catches amount mismatch", () => {
    const pub = samplePub();
    const proof: ZkSpendProof = {
      kind: "zk-spend",
      protocolVersion: "t",
      circuitTag: "t",
      publicInputs: pub,
      publicInputsHex: publicInputsToHex(pub),
      backend: "test",
    };
    const ok = assertProofBindsTxFields(proof, {
      senderId: pub.senderId,
      recipientId: pub.recipientId,
      treasuryId: pub.treasuryId,
      assetId: pub.assetId,
      amount: 1000n,
      fee: 1n,
      nullifier: pub.nullifier,
    });
    assert.equal(ok.ok, true);
    const bad = assertProofBindsTxFields(proof, {
      senderId: pub.senderId,
      recipientId: pub.recipientId,
      treasuryId: pub.treasuryId,
      assetId: pub.assetId,
      amount: 1001n,
      fee: 1n,
      nullifier: pub.nullifier,
    });
    assert.equal(bad.ok, false);
  });

  it("verifyAgainstExpected rejects foreign publics", () => {
    const pub = samplePub();
    const proof: ZkSpendProof = {
      kind: "zk-spend",
      protocolVersion: "t",
      circuitTag: "t",
      publicInputs: pub,
      publicInputsHex: publicInputsToHex(pub),
      vkHex: "aa",
      proofHex: "bb",
      backend: "test",
    };
    const other = { ...pub, amount: Fr.from(2n) };
    // Will fail hex mismatch before SNARK
    assert.equal(verifyZkSpendProofAgainstExpected(proof, other), false);
  });

  it("prove-spend-json publics bind to request economics (needs uep-zk)", () => {
    assert.ok(
      findUepZkBinary(),
      "uep-zk binary required — no SKIP allowed in UEP-29.4 (scripts/build-uep-zk.sh)",
    );
    const secret = Fr.from(11n);
    const salt = Fr.from(22n);
    const senderId = hAccount(secret, salt);
    const amount = 1000n;
    const fee = creatorFee(amount);
    const req = buildPoseidonSpendRequest({
      depth: 4,
      seed: 7,
      senderSecret: secret,
      senderSalt: salt,
      recipientId: Fr.from(33n),
      treasuryId: Fr.from(44n),
      assetId: Fr.from(1n),
      amount,
      fee,
      senderOldBalance: 10_000n,
      noteBlinding: Fr.from(3n),
      recipientBlinding: Fr.from(4n),
      treasuryBlinding: Fr.from(5n),
    });
    const art = zkProveSpendJson(req);
    assert.equal(art.ok, true, art.error ?? art.raw);
    const fromHex = publicInputsFromHex(art.publicInputsHex);
    // amount / fee / recipient from circuit must match request
    assert.equal(fromHex.amount.n, amount);
    assert.equal(fromHex.fee.n, fee);
    assert.equal(fromHex.recipientId.n, 33n);
    assert.equal(fromHex.assetId.n, 1n);
    assert.equal(fromHex.treasuryId.n, 44n);
    // sender_id is H_ACCOUNT(secret,salt) in Poseidon — may differ from TS hAccount (UEP-25)
    // So we only assert economic fields that are plain integers in the request.
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, art.publicInputsHex).ok, true);

    // Foreign amount must fail SNARK
    const bad = [...art.publicInputsHex];
    bad[8] = normalizeFrHex("02");
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, bad).ok, false);
  });
});
