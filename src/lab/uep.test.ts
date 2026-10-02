import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fr } from "../core/field.ts";
import { Domain, h, hAccount, Uep25PrototypeHash, Poseidon2Backend } from "../core/hash.ts";
import { creatorFee } from "../core/fee.ts";
import { SparseMerkleTree, verifyMembership, verifyUpdate, EMPTY_LEAF } from "../core/smt.ts";
import { deriveNullifier, NullifierSet } from "../core/nullifier.ts";
import { transition } from "../core/transition.ts";
import { makeNote, noteCommitment, openNote } from "../core/note.ts";
import { computeTxCommitment, txIdFromCommitment } from "../core/transaction.ts";
import { reconcile, settlementRoot } from "../core/reconciliation.ts";
import { UepAddressV1 } from "../core/address.ts";
import { TESTNET_ASSETS, GLOBAL_ASSETS, INTERPLANETARY_ASSETS } from "../core/assets.ts";
import type { UepTransaction } from "../core/transaction.ts";

function dummyTx(partial: Partial<UepTransaction> & { nullifier: Fr; txId?: Fr }): UepTransaction {
  const txId = partial.txId ?? new Fr(partial.nullifier.n + 99n);
  return {
    version: 1,
    protocol: "UEP-25-prototype",
    networkId: "uep-testnet-1",
    domainId: "EARTH",
    txId,
    senderId: new Fr(1),
    recipientId: new Fr(2),
    assetId: new Fr(3),
    amount: 1000n,
    fee: 1n,
    nonce: new Fr(4),
    nullifier: partial.nullifier,
    inputCommitments: [],
    outputCommitments: [],
    transactionCommitment: new Fr(5),
    spendProof: { kind: "development-mac", backend: "test", payload: "00" },
    phase: "LOCAL_VALID",
    inConflict: false,
    createdAt: 0,
    ...partial,
  };
}

describe("UEP-25 hash vectors (ark-bn254)", () => {
  // The algebraic UEP-25 placeholder was retired; the protocol hash is Poseidon BN254
  // (uep-21 vectors PV-003..PV-007).
  it("matches the Poseidon BN254 domain vectors", () => {
    assert.equal(h(Domain.Account, new Fr(1), new Fr(2)).toHex(), "2532efcfe78ab9af5e8c8e4ee0b167d6cb0e36610b6f0a63f24355aa3c3913d8");
    assert.equal(h(Domain.Nullifier, new Fr(1), new Fr(2)).toHex(), "2ad927924b3ad565b8672e32fd2d67d45496bd17d39b2c1e560092a939594f4b");
    assert.equal(h(Domain.MerkleNode, new Fr(1), new Fr(2)).toHex(), "0581acb2e2c47e75eac65918e47495a3fdc38cd2c8bff2f65419082a5fd4bb83");
    assert.equal(h(Domain.Leaf, new Fr(1), new Fr(2)).toHex(), "2046fd805613ec436c2ec436be6e3bc4867693510f55193052f06bcac7b229fc");
    assert.equal(h(Domain.Transaction, new Fr(1), new Fr(2)).toHex(), "1d8e9b7b988bea72be2170e46368fa1e5d8d64ee7a6ec8d34eaf7d650544df91");
  });

  it("separates domains", () => {
    const a = h(Domain.Account, new Fr(1), new Fr(2));
    const n = h(Domain.Nullifier, new Fr(1), new Fr(2));
    assert.equal(a.eq(n), false);
  });

  it("does not claim to be Poseidon2", () => {
    assert.equal(Uep25PrototypeHash.isPoseidon2, false);
    assert.throws(() => Poseidon2Backend.h(Domain.Account, new Fr(1), new Fr(2)));
  });
});

describe("fee policy", () => {
  it("is max(1, floor(amount * 10 / 10000)) for positive amounts (core and circuit)", () => {
    assert.equal(creatorFee(0n), 0n);
    for (let a = 1n; a < 2000n; a++) assert.equal(creatorFee(a), 1n);
    assert.equal(creatorFee(2000n), 2n);
    assert.equal(creatorFee(100_000n), 100n);
  });
});

describe("transition", () => {
  it("conserves value", () => {
    const r = transition({ sender: 100_000n, recipient: 0n, treasury: 0n }, 10_000n);
    assert.ok("ok" in r);
    if ("ok" in r) {
      assert.equal(r.ok.fee, 10n);
      assert.equal(r.ok.new.sender + r.ok.new.recipient + r.ok.new.treasury, 100_000n);
    }
  });
  it("rejects underflow", () => {
    const r = transition({ sender: 99n, recipient: 0n, treasury: 0n }, 100n);
    assert.ok("err" in r);
  });
  it("rejects overflow", () => {
    const r = transition({ sender: 10_000n, recipient: 2n ** 64n - 1n, treasury: 0n }, 1n);
    assert.ok("err" in r);
  });
});

describe("SMT", () => {
  it("membership and update", () => {
    const t = new SparseMerkleTree(8);
    const emptyRoot = t.root();
    const leaf = new Fr(42);
    const key = new Fr(7);
    const path = t.path(key);
    assert.equal(verifyMembership(emptyRoot, EMPTY_LEAF, path), true);
    t.set(key, leaf);
    const path2 = t.path(key);
    assert.equal(verifyMembership(t.root(), leaf, path2), true);
    assert.equal(verifyUpdate(emptyRoot, t.root(), EMPTY_LEAF, leaf, path), true);
    assert.equal(emptyRoot.eq(t.root()), false);
  });
});

describe("nullifiers", () => {
  it("are deterministic and reject replay", () => {
    const a = deriveNullifier(new Fr(1), new Fr(2));
    const b = deriveNullifier(new Fr(1), new Fr(2));
    assert.ok(a.eq(b));
    const set = new NullifierSet();
    assert.equal(set.insertOnce(a), true);
    assert.equal(set.insertOnce(b), false);
  });
});

describe("notes", () => {
  it("commitment binds amount and asset", () => {
    const n = makeNote(new Fr(1), new Fr(2), 1000n, new Fr(9));
    assert.ok(openNote(n));
    assert.equal(noteCommitment(n.owner, n.assetId, 1001n, n.blinding).eq(n.commitment), false);
    assert.equal(noteCommitment(n.owner, new Fr(99), 1000n, n.blinding).eq(n.commitment), false);
  });
});

describe("addresses", () => {
  // v1 addresses stay retired (public core v0.4.5): encoding throws, decoding returns null.
  it("v1 addresses are retired", () => {
    const id = hAccount(new Fr(1), new Fr(2));
    assert.throws(() => UepAddressV1.encode("uep-testnet-1", id), /ADDRESS_LEGACY_V1/);
    assert.equal(UepAddressV1.decode("uep:uep-testnet-1:zzzz"), null);
  });
});

describe("network isolation of registries", () => {
  it("TESTNET != GLOBAL != INTERPLANETARY", () => {
    const t = new Set(TESTNET_ASSETS.map((a) => a.assetId));
    const g = new Set(GLOBAL_ASSETS.map((a) => a.assetId));
    const i = new Set(INTERPLANETARY_ASSETS.map((a) => a.assetId));
    for (const x of t) assert.equal(g.has(x), false);
    for (const x of t) assert.equal(i.has(x), false);
    for (const x of g) assert.equal(i.has(x), false);
  });
});

describe("UEP-009", () => {
  it("is order-independent and idempotent over 1000 permutations", () => {
    const n1 = new Fr(11);
    const n2 = new Fr(22);
    const a = dummyTx({ nullifier: n1, txId: new Fr(100), amount: 1000n, fee: 1n });
    const b = dummyTx({ nullifier: n1, txId: new Fr(50), amount: 1000n, fee: 1n });
    const c = dummyTx({ nullifier: n2, txId: new Fr(9), amount: 5000n, fee: 5n });
    const base = [a, b, c];
    const ref = settlementRoot(reconcile(base));
    let settled = 0;
    for (let i = 0; i < 1000; i++) {
      const copy = [...base];
      // Fisher–Yates with deterministic LCG
      let s = (i + 1) * 1103515245 + 12345;
      for (let j = copy.length - 1; j > 0; j--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const k = s % (j + 1);
        const tmp = copy[j]!;
        copy[j] = copy[k]!;
        copy[k] = tmp;
      }
      const r = reconcile(copy);
      assert.ok(settlementRoot(r).eq(ref));
      settled = r.filter((x) => x.status === "SETTLED").length;
    }
    assert.equal(settled, 2);
    const again = reconcile([...base, a, b]);
    assert.ok(settlementRoot(again).eq(ref));
    const winner = reconcile(base).find((s) => s.nullifier.eq(n1) && s.status === "SETTLED");
    assert.equal(winner?.txId.n, 50n);
  });
});

describe("canonical tx commitment", () => {
  it("changes when amount changes", () => {
    const args = {
      networkId: "uep-testnet-1",
      senderId: new Fr(1),
      recipientId: new Fr(2),
      assetId: new Fr(3),
      amount: 1000n,
      fee: 1n,
      nonce: new Fr(4),
      nullifier: new Fr(5),
      inputCommitments: [new Fr(6)],
      outputCommitments: [new Fr(7)],
    };
    const c1 = computeTxCommitment(args);
    const c2 = computeTxCommitment({ ...args, amount: 1001n });
    assert.equal(c1.eq(c2), false);
    assert.equal(txIdFromCommitment(c1, args.nullifier).eq(txIdFromCommitment(c2, args.nullifier)), false);
  });
});
