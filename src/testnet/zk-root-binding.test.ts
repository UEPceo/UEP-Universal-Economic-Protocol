/**
 * v0.5.3 crypto alignment, root binding: the ledger trees projected to circuit
 * depth 32 give the four roots a zk-spend must prove (opt-in
 * `zkRootBinding: "circuit-projection"`); one account-id derivation adapter;
 * zk-spend proofs re-verified on restore and on the pending path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { hAccount } from "../core/hash.ts";
import { u64ToFr } from "../core/encoding.ts";
import { SparseMerkleTree } from "../core/smt.ts";
import { accountIdsFromSecrets } from "../core/spend-key.ts";
import { publicInputsOrdered, type SpendPublicInputs } from "../core/spend-proof.ts";
import { validateZkSpendInstance, ZK_WITNESS_CONTRACT_VERSION, type ZkSpendInstance } from "../core/zk-witness-contract.ts";
import { CircuitTreeProjection, CIRCUIT_TREE_DEPTH, circuitBalanceLeaf, zkAccountIdMatches, zkAccountIds, type ZkLedgerTransition, type ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import type { UepTransaction } from "../core/transaction.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const code = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");
const msg = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.message : "");
const trust = { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };

/**
 * Development verifier for tests: the proof names a structural witness the
 * test built; it verifies iff the public inputs are that instance's and the
 * witness passes the UEP-25 tree checks (old roots → new roots at depth 32).
 */
function witnessVerifier(): ZkSpendVerifier & { instances: Map<string, ZkSpendInstance>; calls: number } {
  return {
    keyMode: "development",
    instances: new Map(),
    calls: 0,
    verify(p) {
      this.calls++;
      const inst = this.instances.get(p.proof);
      if (!inst) return false;
      const want = publicInputsOrdered(inst.publicInputs).map((x) => x.toHex());
      if (p.publicInputsHex.some((x, i) => new Fr(BigInt(x.startsWith("0x") ? x : `0x${x}`)).toHex() !== want[i])) return false;
      return validateZkSpendInstance(inst, { checkTrees: true }).ok;
    },
  };
}

function instanceFor(l: UepLedger, tx: UepTransaction, t: ZkLedgerTransition): ZkSpendInstance {
  const bal = (a: Fr) => l.balanceOf(a, tx.assetId);
  const [s, r, tr] = t.steps;
  const p = (x: typeof s.path) => ({ index: x.index, indexBits: x.indexBits, siblings: x.siblings });
  const pub: SpendPublicInputs = {
    ...t.roots,
    senderId: tx.senderId, recipientId: tx.recipientId, treasuryId: TREASURY_ID, assetId: tx.assetId,
    nullifier: tx.nullifier, amount: u64ToFr(tx.amount), fee: u64ToFr(tx.fee), transactionCommitment: tx.transactionCommitment,
  };
  return {
    publicInputs: pub,
    witness: {
      contractVersion: ZK_WITNESS_CONTRACT_VERSION, depth: CIRCUIT_TREE_DEPTH, usePoseidon: false,
      senderSecret: Fr.zero(), senderSalt: Fr.zero(), noteBlinding: Fr.zero(), noteNonce: Fr.zero(),
      senderOldAmount: Fr.from(bal(tx.senderId)), senderNewAmount: Fr.from(bal(tx.senderId) - tx.amount - tx.fee),
      recipientOldAmount: Fr.from(bal(tx.recipientId)), recipientNewAmount: Fr.from(bal(tx.recipientId) + tx.amount),
      treasuryOldAmount: Fr.from(bal(TREASURY_ID)), treasuryNewAmount: Fr.from(bal(TREASURY_ID) + tx.fee),
      midRootAfterSender: s.rootAfter, midRootAfterRecipient: r.rootAfter,
      senderPath: p(s.path), senderOldLeaf: s.oldLeaf, senderNewLeaf: s.newLeaf,
      recipientPath: p(r.path), recipientOldLeaf: r.oldLeaf, recipientNewLeaf: r.newLeaf, recipientBlinding: Fr.zero(),
      treasuryPath: p(tr.path), treasuryOldLeaf: tr.oldLeaf, treasuryNewLeaf: tr.newLeaf, treasuryBlinding: Fr.zero(),
      nullifierPath: p(t.nullifierPath), nullifierLeaf: tx.nullifier,
    },
  };
}

function zkTx(tx: UepTransaction, inst: ZkSpendInstance, proof: string, tweak?: (pi: string[]) => void): UepTransaction {
  const pi = publicInputsOrdered(inst.publicInputs).map((x) => x.toHex());
  tweak?.(pi);
  return { ...tx, spendProof: { kind: "zk-spend", backend: "groth16-bn254", payload: JSON.stringify({ publicInputsHex: pi, proof }) } };
}

async function setup(v: ZkSpendVerifier, zkRootBinding: "off" | "circuit-projection" = "circuit-projection") {
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v, zkRootBinding });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, EUR, 10_000n);
  return { l, a, b };
}

function prepared(l: UepLedger, a: Awaited<ReturnType<typeof identityFromMnemonic>>, b: { accountId: Fr }, v: ReturnType<typeof witnessVerifier>, amount: bigint, id: string) {
  const p = l.prepareSpend(a, b.accountId, EUR, amount);
  assert.ok("tx" in p);
  const t = l.zkTransitionFor(p.tx);
  assert.ok("ok" in t, "error" in t ? t.error : "");
  const inst = instanceFor(l, p.tx, t.ok);
  v.instances.set(id, inst);
  return { tx: p.tx, inst };
}

test("projection: depth-32 view of a full-key tree, slot collisions refused", () => {
  const full = new SparseMerkleTree();
  const k1 = new Fr((7n << 100n) | 5n), k2 = new Fr((9n << 60n) | 6n);
  full.set(k1, new Fr(11n)); full.set(k2, new Fr(22n));
  const proj = CircuitTreeProjection.of(full);
  const manual = new SparseMerkleTree(CIRCUIT_TREE_DEPTH);
  manual.setIndex(5n, new Fr(11n)); manual.setIndex(6n, new Fr(22n));
  assert.ok(proj.root().eq(manual.root()));
  assert.ok(CircuitTreeProjection.of(full, circuitBalanceLeaf).get(k1).eq(circuitBalanceLeaf(new Fr(11n))));
  const clash = new Fr((3n << 200n) | 5n); // same low 32 bits as k1
  assert.throws(() => proj.set(clash, new Fr(1n)), /ZK_SLOT_COLLISION/);
  full.set(clash, new Fr(33n));
  assert.throws(() => CircuitTreeProjection.of(full), /ZK_SLOT_COLLISION/);
  assert.throws(() => new CircuitTreeProjection(0), /ZK_DEPTH_INVALID/);
});

test("root binding: a zk-spend must prove the projected ledger roots (old and new)", async () => {
  const v = witnessVerifier();
  const { l, a, b } = await setup(v);
  const { tx, inst } = prepared(l, a, b, v, 1_000n, "p1");
  assert.equal(validateZkSpendInstance(inst, { checkTrees: true }).ok, true);
  for (const i of [0, 1, 2, 3]) {
    const r = l.submit(zkTx(tx, inst, "p1", (pi) => { pi[i] = "0x1234"; }));
    assert.equal(code(r), "PROOF");
    assert.match(msg(r), new RegExp(`public inputs ${i} do not match the projected ledger roots`));
  }
  assert.equal(v.calls, 0); // roots are checked before the verifier
  assert.equal(code(l.submit(zkTx(tx, inst, "p1"))), "OK");
  assert.equal(l.balanceOfAsset(b.accountId, EUR), 1_000n);
  // The projection follows the ledger: the new roots of the accepted spend are the old roots of the next.
  const next = prepared(l, a, b, v, 500n, "p2");
  assert.ok(next.inst.publicInputs.oldStateRoot.eq(inst.publicInputs.newStateRoot));
  assert.ok(next.inst.publicInputs.oldNullifierRoot.eq(inst.publicInputs.newNullifierRoot));
  // A proof over the stale roots no longer binds.
  const stale = zkTx(next.tx, next.inst, "p2", (pi) => { pi[0] = inst.publicInputs.oldStateRoot.toHex(); pi[1] = inst.publicInputs.newStateRoot.toHex(); });
  assert.equal(code(l.submit(stale)), "PROOF");
  assert.equal(code(l.submit(zkTx(next.tx, next.inst, "p2"))), "OK");
});

test("root binding off (default): roots stay unbound; restore re-verifies zk-spends", async () => {
  const v = witnessVerifier();
  const { l, a, b } = await setup(v, "off");
  const { tx, inst } = prepared(l, a, b, v, 1_000n, "p1");
  assert.equal(code(l.submit(zkTx(tx, inst, "p1"))), "OK");
  const snap = l.snapshot();
  assert.throws(() => UepLedger.restore(structuredClone(snap), trust), /INVALID_SNAPSHOT_ZK_VERIFIER/);
  const reject: ZkSpendVerifier = { keyMode: "development", verify: () => false };
  assert.throws(() => UepLedger.restore(structuredClone(snap), trust, {}, { zkSpendVerifier: reject }), /INVALID_SNAPSHOT_TX_ZK_PROOF/);
  const restored = UepLedger.restore(structuredClone(snap) as UepLedgerSnapshot, trust, {}, { zkSpendVerifier: v });
  assert.equal(restored.balanceOfAsset(b.accountId, EUR), 1_000n);
  assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, zkRootBinding: "x" as "off" }), /ZK_ROOT_BINDING_INVALID/);
});

test("pending path: a queued zk-spend passes the same binding and verifier", async () => {
  const v = witnessVerifier();
  const { l, a, b } = await setup(v, "off");
  const { tx, inst } = prepared(l, a, b, v, 1_000n, "p1");
  assert.equal(code(l.enqueuePending(zkTx(tx, inst, "forged"))), "PROOF");
  assert.equal(code(l.enqueuePending(zkTx(tx, inst, "p1", (pi) => { pi[8] = "0x1"; }))), "PROOF");
  assert.equal(code(l.enqueuePending(zkTx(tx, inst, "p1"))), "OK");
});

test("account-id adapter: one derivation function for core and circuit ids", async () => {
  const id = await identityFromMnemonic(await generateMnemonic(128));
  const ids = accountIdsFromSecrets(id.secret, id.salt);
  const core = zkAccountIds(id.secret, id.salt);
  assert.ok(core[0]!.eq(ids.v3) && core[1]!.eq(ids.v2));
  assert.ok(zkAccountIdMatches(id.accountId, id.secret, id.salt));
  assert.ok(zkAccountIds(id.secret, id.salt, "circuit-h-account")[0]!.eq(hAccount(id.secret, id.salt)));
  assert.equal(zkAccountIdMatches(id.accountId, id.secret, id.salt, "circuit-h-account"), false);
  assert.throws(() => zkAccountIds(id.secret, id.salt, "x" as "core-key-derived"), /ZK_ACCOUNT_DERIVATION_INVALID/);
});
