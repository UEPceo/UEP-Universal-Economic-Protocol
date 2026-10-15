/**
 * 0.5.83: real Groth16 proofs (development keys, depth 4) for circuit v6.
 * PI[11] is the circuit commitment hFoldV2(D_TX, publics), not the wallet's
 * canonicalTxCommitment; the v6 ledger binding checks exactly that relation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { findUepZkBinary, zkProveSpendJson, zkVerifyHex } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";
import { circuitTxCommitmentOf, parseZkSpendPayload, zkPayloadVersion } from "../core/zk-tx-adapter.ts";
import { canonicalTxCommitment } from "../core/encoding.ts";

const base = () => buildPoseidonSpendRequest({
  depth: 4, senderSecret: Fr.from(11n), senderSalt: Fr.from(22n), recipientId: Fr.from(33n), treasuryId: Fr.from(44n),
  assetId: Fr.from(1n), amount: 1000n, senderOldBalance: 10_000n, noteBlinding: Fr.from(3n), recipientBlinding: Fr.from(4n), treasuryBlinding: Fr.from(5n),
});

describe("spend circuit v6: real proofs", () => {
  it("PI[11] = circuit commitment of the proof's publics; differs from canonicalTxCommitment", () => {
    assert.ok(findUepZkBinary(), "uep-zk binary required (scripts/build-uep-zk.sh)");
    const art = zkProveSpendJson({ ...base(), circuit_version: 6 });
    assert.equal(art.ok, true, art.error ?? art.raw);
    const pi = art.publicInputsHex;
    assert.equal(pi.length, 13);
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, pi).ok, true);
    assert.ok(circuitTxCommitmentOf(pi).eq(new Fr(BigInt(`0x${pi[11]!.replace(/^0x/, "")}`))), "v6 binding relation holds for a real proof");
    const p = parseZkSpendPayload({ kind: "zk-spend", backend: "groth16-bn254", payload: JSON.stringify({ publicInputsHex: pi, proof: art.proofHex, senderNextBlinding: "0x1" }) });
    assert.ok(p && zkPayloadVersion(p) === 6);
    // Same economic fields through the wallet commitment: a different value, so the pre-0.5.83 binding of
    // PI[11] to tx.transactionCommitment could not be met by any real proof.
    const frs = pi.map((x) => new Fr(BigInt(`0x${x.replace(/^0x/, "")}`)));
    assert.ok(!canonicalTxCommitment([...frs.slice(0, 11), frs[12]!]).eq(frs[11]!));
    const bad = [...pi]; bad[12] = "00".repeat(31) + "02";
    assert.equal(zkVerifyHex(art.vkHex!, art.proofHex!, bad).ok, false, "domain_id is a bound public input");
  });

  it("v6 differs from v5 for the same request; empty recipient slot is provable in v6 only", () => {
    const v5 = zkProveSpendJson(base());
    const v6 = zkProveSpendJson({ ...base(), circuit_version: 6 });
    assert.equal(v5.ok && v6.ok, true);
    assert.notEqual(v5.vkHex, v6.vkHex);
    assert.notEqual(v5.publicInputsHex[1], v6.publicInputsHex[1], "sender leaf rotates in v6");
    const empty = zkProveSpendJson({ ...base(), circuit_version: 6, recipient_slot_empty: true });
    assert.equal(empty.ok, true, empty.error ?? empty.raw);
    assert.equal(zkVerifyHex(empty.vkHex!, empty.proofHex!, empty.publicInputsHex).ok, true);
    assert.equal(zkProveSpendJson({ ...base(), recipient_slot_empty: true }).ok, false);
  });
});
