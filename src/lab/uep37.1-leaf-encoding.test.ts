/**
 * UEP-37.1 — Leaf encoding freeze, depth policy, nullifiers, honest backend labels
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import {
  CANONICAL_SMT_DEPTH,
  TEST_ONLY_SMT_DEPTH,
  LEAF_ENCODING_VERSION,
  noteCommitment,
  noteCommitmentFromAmount,
  noteNonce,
  nullifierFrom,
  accountIndex,
  leafEncodingMeta,
  isPoseidonBackendActive,
  activeHashBackendKind,
  LAB_ZERO_BLINDING,
  CANONICAL_ASSET_ID,
} from "./uep37-leaf-encoding.ts";
import {
  SmtEconomicState,
  accountLabelToFr,
  SMT_STATE_VERSION,
} from "./uep37-smt-economic-state.ts";
import { parallelSafeScheduleApply } from "./uep36-parallel-exec.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import { hLeaf } from "../core/hash.ts";

describe("UEP-37.1 leaf encoding + SMT semantics", () => {
  it("versions pinned", () => {
    assert.equal(LEAF_ENCODING_VERSION, "37.1");
    assert.match(SMT_STATE_VERSION, /^37\./); // leaf encoding 37.1; SMT state evolved to 37.4+
    assert.equal(CANONICAL_SMT_DEPTH, 32);
  });

  it("meta declares the core hash backend is Poseidon BN254 (bit-identical with the circuit)", () => {
    const m = leafEncodingMeta();
    assert.equal(m.poseidonBitIdentical, true);
    assert.equal(activeHashBackendKind(), "poseidon-bn254");
    assert.equal(isPoseidonBackendActive(), true);
  });

  it("note_commitment matches nested H_LEAF formula", () => {
    const owner = Fr.from(10n);
    const asset = Fr.from(1n);
    const amount = Fr.from(100n);
    const blind = Fr.from(7n);
    const expected = hLeaf(hLeaf(owner, hLeaf(asset, amount)), blind);
    assert.equal(noteCommitment(owner, asset, amount, blind).toHex(), expected.toHex());
  });

  it("changing amount or blinding changes commitment", () => {
    const o = Fr.from(1n);
    const a = noteCommitmentFromAmount(o, 100n, LAB_ZERO_BLINDING);
    const b = noteCommitmentFromAmount(o, 101n, LAB_ZERO_BLINDING);
    const c = noteCommitmentFromAmount(o, 100n, Fr.from(1n));
    assert.notEqual(a.toHex(), b.toHex());
    assert.notEqual(a.toHex(), c.toHex());
  });

  it("account index is lowBits(owner, depth)", () => {
    const id = Fr.from(0x1_0000_00ffn);
    assert.equal(accountIndex(id, 8), 0xffn);
    assert.equal(accountIndex(id, 32), id.lowBits(32));
  });

  it("production genesis defaults to depth 32", () => {
    const s = SmtEconomicState.genesis({ s0: 10n });
    assert.equal(s.depth, 32);
    assert.equal(s.isTestFixture, false);
    assert.equal(s.meta().encoding.canonicalDepth, 32);
  });

  it("test-only depth must be explicit", () => {
    const s = SmtEconomicState.genesis(
      { s0: 10n },
      { testOnlyDepth: TEST_ONLY_SMT_DEPTH, isTestFixture: true },
    );
    assert.equal(s.depth, 16);
    assert.equal(s.isTestFixture, true);
  });

  it("nullifier insert is idempotent-reject", () => {
    const s = SmtEconomicState.genesis(
      { s0: 100n },
      { testOnlyDepth: 8, isTestFixture: true },
    );
    const nf = nullifierFrom(Fr.from(9n), Fr.from(3n));
    assert.equal(s.insertNullifier(nf).ok, true);
    const nfRoot1 = s.nullifierRoot();
    assert.equal(s.insertNullifier(nf).ok, false);
    assert.equal(s.nullifierRoot(), nfRoot1);
  });

  it("applyBatch advances account root and records NF root history", () => {
    const s = SmtEconomicState.genesis(
      { s0: 1000n, r0: 0n },
      { testOnlyDepth: 8, isTestFixture: true },
    );
    const prev = s.previousRoot();
    const prevNf = s.previousNullifierRoot();
    const nf = nullifierFrom(Fr.from(1n), Fr.from(2n));
    const r = s.applyBatch([{ id: "t", from: "s0", to: "r0", amount: 10n }], [nf]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.notEqual(r.stateRoot, prev);
      assert.notEqual(r.nullifierRoot, prevNf);
      assert.equal(s.hasNullifier(nf.toHex()), true);
    }
  });

  it("duplicate nullifier in batch fails", () => {
    const s = SmtEconomicState.genesis(
      { s0: 1000n, r0: 0n },
      { testOnlyDepth: 8, isTestFixture: true },
    );
    const nf = nullifierFrom(Fr.from(5n), Fr.from(6n));
    assert.equal(s.applyBatch([{ id: "a", from: "s0", to: "r0", amount: 1n }], [nf]).ok, true);
    const r2 = s.applyBatch([{ id: "b", from: "s0", to: "r0", amount: 1n }], [nf]);
    assert.equal(r2.ok, false);
  });

  it("sequential ≡ scheduled with note_commitment leaves", () => {
    const eco = SmtEconomicState.genesis(
      { s0: 1000n, s1: 1000n, r0: 0n, r1: 0n },
      { testOnlyDepth: 16, isTestFixture: true },
    );
    const r = parallelSafeScheduleApply(eco, [
      { id: "t1", from: "s0", to: "r0", amount: 3n },
      { id: "t2", from: "s1", to: "r1", amount: 4n },
    ]);
    assert.equal(r.fullStateEqual, true);
    assert.equal(r.sequentialRoot, r.scheduledRoot);
  });

  it("multi-node canonical depth 32 converges (SMT + note leaves)", () => {
    const cluster = new MultiNodeCluster(4, 3710, { useSmtState: true });
    // default depth 32
    assert.ok(cluster.node("mn-0").economic instanceof SmtEconomicState);
    const eco = cluster.node("mn-0").economic as SmtEconomicState;
    assert.equal(eco.depth, 32);
    assert.equal(eco.meta().poseidonBitIdentical, true);

    const prop = cluster.proposeAggregateFrom("mn-0", [
      { txs: [{ id: "n1", from: "s0", to: "r0", amount: 2n }] },
    ]);
    assert.ok(prop);
    for (let i = 0; i < 80; i++) {
      cluster.tick(20, 5);
      if (
        cluster.allHonestSameStateRoot() &&
        cluster.nodes.filter((n) => !n.byzantine).every((n) => n.economic.sequence >= 1)
      )
        break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("golden structural vector: fixed inputs → stable commitment (UEP-25 backend)", () => {
    // These values are structural under UEP-25 placeholder — NOT circuit Poseidon goldens.
    // Documented for regression; Poseidon goldens require uep-zk / cargo test offline.
    const owner = Fr.from(42n);
    const leaf = noteCommitment(
      owner,
      CANONICAL_ASSET_ID,
      Fr.from(1000n),
      LAB_ZERO_BLINDING,
    );
    const again = noteCommitment(
      owner,
      CANONICAL_ASSET_ID,
      Fr.from(1000n),
      LAB_ZERO_BLINDING,
    );
    assert.equal(leaf.toHex(), again.toHex());
    assert.equal(leaf.toHex().length, 64);
    // nonce path
    const nonce = noteNonce(leaf, LAB_ZERO_BLINDING);
    assert.notEqual(nonce.toHex(), leaf.toHex());
  });
});
