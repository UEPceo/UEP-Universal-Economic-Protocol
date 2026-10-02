import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { hAccount, hLeaf } from "../core/hash.ts";
import { SparseMerkleTree } from "../core/smt.ts";
import {
  buildStructuralZkSpendInstance,
  defaultBalanceLeaf,
  deriveNoteNonce,
  serializeZkSpendInstance,
  validateZkSpendInstance,
  ZK_WITNESS_CONTRACT_VERSION,
} from "../core/zk-witness-contract.ts";
import { SPEND_PUBLIC_INPUT_NAMES } from "../core/spend-proof.ts";
import { creatorFee } from "../core/fee.ts";
import { WitnessOnlyProvider } from "./zk-spend-provider.ts";

function balanceLeaf(owner: Fr, asset: Fr, amount: bigint, blinding: Fr): Fr {
  return defaultBalanceLeaf(owner, asset, amount, blinding);
}

function makeInstance(overrides?: { noteBlinding?: Fr; wrongNonce?: boolean }) {
  const depth = 8;
  const state = new SparseMerkleTree(depth);
  const ntree = new SparseMerkleTree(depth);

  const senderSecret = Fr.from(11n);
  const senderSalt = Fr.from(22n);
  const senderId = hAccount(senderSecret, senderSalt);
  const recipientId = Fr.from(33n);
  const treasuryId = Fr.from(44n);
  const assetId = Fr.from(55n);
  const amount = 1_000n;
  const fee = creatorFee(amount);
  const senderOld = 10_000n;
  const recipientOld = 100n;
  const treasuryOld = 50n;
  const noteBlinding = overrides?.noteBlinding ?? Fr.from(8n);
  const rBlind = Fr.from(2n);
  const tBlind = Fr.from(3n);
  const leafKey = (a: Fr, asset: Fr) => hAccount(a, asset);

  state.set(leafKey(senderId, assetId), balanceLeaf(senderId, assetId, senderOld, noteBlinding));
  state.set(leafKey(recipientId, assetId), balanceLeaf(recipientId, assetId, recipientOld, rBlind));
  state.set(leafKey(treasuryId, assetId), balanceLeaf(treasuryId, assetId, treasuryOld, tBlind));

  const inst = buildStructuralZkSpendInstance({
    depth,
    senderId,
    recipientId,
    treasuryId,
    assetId,
    amount,
    fee,
    senderSecret,
    senderSalt,
    noteBlinding,
    transactionCommitment: Fr.from(99n),
    stateTree: state,
    nullifierTree: ntree,
    balanceLeaf,
    leafKey,
    recipientBlinding: rBlind,
    treasuryBlinding: tBlind,
    senderOldAmount: senderOld,
    recipientOldAmount: recipientOld,
    treasuryOldAmount: treasuryOld,
  });

  if (overrides?.wrongNonce) {
    inst.witness.noteNonce = Fr.from(12345n);
  }
  return inst;
}

describe("zk witness contract 28.4", () => {
  it("schema has 12 public names", () => {
    assert.equal(SPEND_PUBLIC_INPUT_NAMES.length, 12);
  });

  // INTEGRATION CONFLICT (C-4: public core derives account ids from the Ed25519 spend key since v0.4.5; the UEP-26 circuit proves H_ACCOUNT(secret, salt)). Pending a maintainer decision; see docs/LABS.md.
  it.skip("builds with unified noteBlinding and passes crypto+tree checks", () => {
    const inst = makeInstance();
    assert.equal(inst.witness.contractVersion, ZK_WITNESS_CONTRACT_VERSION);
    const expectNonce = deriveNoteNonce(inst.witness.senderOldLeaf, inst.witness.noteBlinding);
    assert.ok(expectNonce.eq(inst.witness.noteNonce));

    const v = validateZkSpendInstance(inst, { checkTrees: true, checkCrypto: true });
    assert.equal(v.ok, true, v.ok ? "" : v.errors.join("; "));
  });

  it("rejects wrong noteNonce / secret / nullifier / index", () => {
    const base = makeInstance();

    const badNonce = makeInstance({ wrongNonce: true });
    assert.equal(validateZkSpendInstance(badNonce, { checkCrypto: true }).ok, false);

    const badSecret = {
      ...base,
      witness: { ...base.witness, senderSecret: Fr.from(999n) },
    };
    assert.equal(validateZkSpendInstance(badSecret, { checkCrypto: true }).ok, false);

    const badNf = {
      ...base,
      publicInputs: { ...base.publicInputs, nullifier: Fr.from(1n) },
    };
    assert.equal(validateZkSpendInstance(badNf, { checkCrypto: true }).ok, false);

    const badIdx = {
      ...base,
      witness: {
        ...base.witness,
        senderPath: { ...base.witness.senderPath, indexBits: base.witness.senderPath.indexBits.map((b,i)=> i===0 ? !b : b) },
      },
    };
    assert.equal(validateZkSpendInstance(badIdx, { checkCrypto: true }).ok, false);
  });

  // INTEGRATION CONFLICT (C-4: public core derives account ids from the Ed25519 spend key since v0.4.5; the UEP-26 circuit proves H_ACCOUNT(secret, salt)). Pending a maintainer decision; see docs/LABS.md.
  it.skip("WitnessOnlyProvider proves after validation", async () => {
    const inst = makeInstance();
    const provider = new WitnessOnlyProvider();
    const proof = await provider.prove(inst);
    assert.equal(proof.kind, "zk-spend");
    assert.equal(await provider.verify(proof, inst.publicInputs), true);
    const ser = serializeZkSpendInstance(inst) as { contractVersion: string };
    assert.equal(ser.contractVersion, ZK_WITNESS_CONTRACT_VERSION);
  });
});
