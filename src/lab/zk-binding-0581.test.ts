/**
 * 0.5.81 item 7: ZK public-input binding, negative field mutation, TS<->Rust cross-check,
 * reproducible public-input vector. Needs the uep-zk DEV binary (scripts/build-uep-zk.sh).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { Domain, hAccount, hFoldV2 } from "../core/hash.ts";
import { publicInputsFromHex, publicInputsToHex, assertProofBindsTxFields, normalizeFrHex, ZK_PUBLIC_INPUT_COUNT } from "./zk-public-inputs.ts";
import { SPEND_PUBLIC_INPUT_NAMES } from "../core/spend-proof.ts";
import type { ZkSpendProof } from "./zk-spend-provider.ts";
import { findUepZkBinary, zkProveSpendJson, zkVerifyHex } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";

const VECTOR = new URL("./fixtures/zk-binding-0581-vector.json", import.meta.url);
const request = () => {
  const secret = Fr.from(11n), salt = Fr.from(22n), amount = 1000n;
  return buildPoseidonSpendRequest({ depth: 4, seed: 7, senderSecret: secret, senderSalt: salt, recipientId: Fr.from(33n), treasuryId: Fr.from(44n), assetId: Fr.from(1n), amount, fee: creatorFee(amount), senderOldBalance: 10_000n, noteBlinding: Fr.from(3n), recipientBlinding: Fr.from(4n), treasuryBlinding: Fr.from(5n) });
};

test("item 7: every one of the 13 public inputs is bound; mutating any single one fails Groth16 verification", () => {
  assert.ok(findUepZkBinary(), "uep-zk binary required (scripts/build-uep-zk.sh); no skip");
  const art = zkProveSpendJson(request());
  assert.equal(art.ok, true, art.error ?? art.raw);
  assert.equal(art.publicInputsHex.length, ZK_PUBLIC_INPUT_COUNT);
  assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, art.publicInputsHex).ok, true);
  for (let i = 0; i < ZK_PUBLIC_INPUT_COUNT; i++) {
    const bad = [...art.publicInputsHex];
    const v = BigInt("0x" + normalizeFrHex(bad[i]!));
    bad[i] = normalizeFrHex((v + 1n).toString(16));
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, bad).ok, false, `public input ${i} (${SPEND_PUBLIC_INPUT_NAMES[i] ?? "domain_id"}) not bound`);
  }
});

test("item 7: TS reference recomputes the Rust transaction_commitment and sender_id (cross-check), and the public-input vector is reproducible", () => {
  const art = zkProveSpendJson(request());
  assert.equal(art.ok, true, art.error ?? art.raw);
  const hex = art.publicInputsHex.map(normalizeFrHex);
  const items = [2, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(i => hex[i]!)].map(x => typeof x === "number" ? Fr.from(BigInt(x)) : Fr.from(BigInt("0x" + x)));
  assert.equal(normalizeFrHex(hFoldV2(Domain.Transaction, items).n.toString(16)), hex[11], "TS hFoldV2(D_TX, ...) != Rust transaction_commitment");
  assert.equal(publicInputsFromHex(art.publicInputsHex).senderId.n, hAccount(Fr.from(11n), Fr.from(22n)).n);
  // Same request -> identical publics (proof bytes are randomized, publics are not).
  assert.deepEqual(zkProveSpendJson(request()).publicInputsHex.map(normalizeFrHex), hex);
  if (process.env.UEP_WRITE_VECTORS === "1" || !existsSync(VECTOR)) writeFileSync(VECTOR, JSON.stringify({ request: "zk-binding-0581 depth4 seed7 amount1000", publicInputsHex: hex }, null, 2) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(VECTOR, "utf8")).publicInputsHex, hex, "public-input vector drifted (circuit change needs a new circuit tag and VK pin)");
});

test("item 7: tx-field binding rejects each mutated economic field", () => {
  const art = zkProveSpendJson(request());
  const pub = publicInputsFromHex(art.publicInputsHex);
  const proof: ZkSpendProof = { kind: "zk-spend", protocolVersion: "t", circuitTag: "t", publicInputs: pub, publicInputsHex: publicInputsToHex(pub), backend: "test" };
  const base = { senderId: pub.senderId, recipientId: pub.recipientId, treasuryId: pub.treasuryId, assetId: pub.assetId, amount: pub.amount.n, fee: pub.fee.n, nullifier: pub.nullifier };
  assert.equal(assertProofBindsTxFields(proof, base).ok, true);
  for (const k of Object.keys(base) as (keyof typeof base)[]) {
    const v = base[k];
    const mutated = { ...base, [k]: typeof v === "bigint" ? v + 1n : Fr.from((v as Fr).n + 1n) };
    assert.equal(assertProofBindsTxFields(proof, mutated).ok, false, `${k} mutation accepted`);
  }
});
