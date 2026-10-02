/**
 * The core Poseidon BN254 hash matches the uep-21 golden vectors
 * (uep-core/uep-21-poseidon/vectors/UEP-26-POSEIDON-VECTORS.json), which come from the
 * Rust arkworks implementation used by the UEP-26 spend circuit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Fr } from "./field.ts";
import { Domain, getHashBackend, h, hNullifier, PoseidonBn254Hash } from "./hash.ts";
import { noteCommitment, noteNonce } from "./note.ts";
import { poseidon2 } from "./poseidon.ts";

type Vector = { id: string; kind: string; domain?: number; inputs: any; expected_be_hex: string };
const file = new URL("../../uep-core/uep-21-poseidon/vectors/UEP-26-POSEIDON-VECTORS.json", import.meta.url);
const vectors: Vector[] = JSON.parse(readFileSync(file, "utf8")).vectors;
const fr = (x: string) => new Fr(BigInt(x));
const hex = (x: Fr) => "0x" + x.toHex();

describe("Poseidon BN254 (core protocol hash)", () => {
  it("is the active backend", () => {
    assert.equal(getHashBackend(), PoseidonBn254Hash);
    assert.equal(PoseidonBn254Hash.isPoseidon2, false);
  });

  it("matches every uep-21 golden vector", () => {
    assert.ok(vectors.length >= 10);
    for (const v of vectors) {
      let got: Fr;
      switch (v.kind) {
        case "poseidon2input":
          got = new Fr(poseidon2(BigInt(v.inputs[0]), BigInt(v.inputs[1])));
          break;
        case "domain":
          got = h(v.domain as Domain, fr(v.inputs[0]), fr(v.inputs[1]));
          break;
        case "note_commitment":
          got = noteCommitment(fr(v.inputs.owner), fr(v.inputs.asset), BigInt(v.inputs.amount), fr(v.inputs.blinding));
          break;
        case "note_nonce":
          got = noteNonce(fr(v.inputs.commitment), fr(v.inputs.blinding));
          break;
        case "nullifier":
          got = hNullifier(fr(v.inputs.secret), fr(v.inputs.nonce));
          break;
        default:
          throw new Error(`unknown vector kind ${v.kind}`);
      }
      assert.equal(hex(got).toLowerCase(), BigInt(v.expected_be_hex).toString(16).padStart(64, "0").replace(/^/, "0x"), v.id);
    }
  });

  it("domain separation and argument order matter", () => {
    const a = fr("0x1");
    const b = fr("0x2");
    assert.notEqual(hex(h(Domain.Leaf, a, b)), hex(h(Domain.MerkleNode, a, b)));
    assert.notEqual(hex(h(Domain.Leaf, a, b)), hex(h(Domain.Leaf, b, a)));
  });

  it("rejects non-canonical inputs", () => {
    const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    assert.throws(() => poseidon2(p, 0n), /POSEIDON_INPUT_NOT_CANONICAL/);
    assert.throws(() => poseidon2(-1n, 0n), /POSEIDON_INPUT_NOT_CANONICAL/);
  });
});
