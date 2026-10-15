/**
 * 0.5.83: spend circuit v6 on the ledger path: 13 public inputs, PI[11] is the
 * circuit commitment of the proof's own publics, PI[12] the ledger domain, the
 * projection carries per-slot blindings (rotated on every v6 spend), root
 * binding on by default, legacy v5 payloads behind a compat flag.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger, type UepLedgerSnapshot } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { u64ToFr } from "../core/encoding.ts";
import { clientBlinding } from "../core/client-note.ts";
import { assertRootBindingAllowed, circuitDomainId, circuitTxCommitmentOf, parseZkSpendPayload, zkPayloadVersion, type ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import type { UepTransaction } from "../core/transaction.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const code = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");
const msg = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.message : "");
const trust = { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };

/** Development verifier: accepts exactly the public-input vectors the test registered. */
function registry(): ZkSpendVerifier & { ok: Set<string>; calls: number } {
  return { keyMode: "development", ok: new Set(), calls: 0, verify(p) { this.calls++; return this.ok.has(`${p.proof}|${p.publicInputsHex.join(",")}`); } };
}

async function setup(v: ZkSpendVerifier, extra: Record<string, unknown> = {}) {
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v, ...extra });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, EUR, 10_000n, clientBlinding(16801625135n));
  return { l, a, b };
}

/** v6 publics the ledger expects for `tx` with the sender's next blinding `nb`. */
function v6Inputs(l: UepLedger, tx: UepTransaction, nb: Fr): string[] {
  const t = l.zkTransitionFor(tx, { version: 6, senderNextBlinding: nb });
  assert.ok("ok" in t, "error" in t ? t.error : "");
  const r = t.ok.roots;
  const pi = [r.oldStateRoot, r.newStateRoot, r.oldNullifierRoot, r.newNullifierRoot, tx.senderId, tx.recipientId, TREASURY_ID, tx.assetId, u64ToFr(tx.amount), u64ToFr(tx.fee), tx.nullifier, Fr.zero(), l.zkDomainId()].map((x) => x.toHex());
  pi[11] = circuitTxCommitmentOf(pi).toHex();
  return pi;
}

function zk(tx: UepTransaction, pi: string[], proof: string, nb?: Fr): UepTransaction {
  return { ...tx, spendProof: { kind: "zk-spend", backend: "groth16-bn254", payload: JSON.stringify({ publicInputsHex: pi, proof, ...(nb ? { senderNextBlinding: nb.toHex() } : {}) }) } };
}

test("v6: accepted with PI[11] = circuit commitment and PI[12] = domain; blinding recorded", async () => {
  const v = registry();
  const { l, a, b } = await setup(v);
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  const nb = new Fr(123456789n);
  const pi = v6Inputs(l, p.tx, nb);
  v.ok.add(`p1|${pi.join(",")}`);
  assert.ok(!new Fr(BigInt(pi[12]!)).eq(circuitDomainId("MARS")) && !new Fr(BigInt(pi[12]!)).isZero());
  // G3: the circuit's PI[11] is not the ledger's canonical tx commitment.
  assert.notEqual(pi[11], p.tx.transactionCommitment.toHex());
  const asLedger = [...pi]; asLedger[11] = p.tx.transactionCommitment.toHex();
  v.ok.add(`p1|${asLedger.join(",")}`);
  assert.match(msg(l.submit(zk(p.tx, asLedger, "p1", nb))), /public inputs 11 do not match/);
  // G1: domain bound.
  const other = [...pi]; other[12] = circuitDomainId("MARS").toHex(); other[11] = circuitTxCommitmentOf(other).toHex();
  v.ok.add(`p1|${other.join(",")}`);
  assert.match(msg(l.submit(zk(p.tx, other, "p1", nb))), /public inputs 12 do not match/);
  // missing senderNextBlinding on a 13-input payload is malformed
  assert.match(msg(l.submit(zk(p.tx, pi, "p1"))), /Malformed/);
  assert.equal(code(l.submit(zk(p.tx, pi, "p1", nb))), "OK");
  assert.ok(l.zkBlindingOf(l.zkSlotKey(a.accountId, p.tx.assetId)).eq(nb));
});

test("v6 projection: a balance returning to an earlier value gives a fresh circuit leaf (F1 on the ledger side)", async () => {
  const v = registry();
  const { l, a, b } = await setup(v);
  const key = l.zkSlotKey(a.accountId, (l.prepareSpend(a, b.accountId, EUR, 1n) as { tx: UepTransaction }).tx.assetId);
  const leaf0 = l.zkCircuitProjection(6).state.get(key);
  const leaf0v5 = l.zkCircuitProjection(5).state.get(key);
  // spend, then refill to the same balance
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  const nb = new Fr(777n);
  const pi = v6Inputs(l, p.tx, nb);
  v.ok.add(`x|${pi.join(",")}`);
  assert.equal(code(l.submit(zk(p.tx, pi, "x", nb))), "OK");
  const spent = 10_000n - l.balanceOfAsset(a.accountId, EUR);
  l.faucet(a.accountId, EUR, spent, clientBlinding(5n));
  assert.equal(l.balanceOfAsset(a.accountId, EUR), 10_000n);
  assert.ok(l.zkCircuitProjection(5).state.get(key).eq(leaf0v5), "legacy projection repeats the leaf");
  assert.ok(!l.zkCircuitProjection(6).state.get(key).eq(leaf0), "v6 projection does not");
});

test("v6: restore rebuilds blindings from committed txs (no snapshot format change)", async () => {
  const v = registry();
  const { l, a, b } = await setup(v);
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  const nb = new Fr(42n);
  const pi = v6Inputs(l, p.tx, nb);
  v.ok.add(`r|${pi.join(",")}`);
  assert.equal(code(l.submit(zk(p.tx, pi, "r", nb))), "OK");
  const r = UepLedger.restore(structuredClone(l.snapshot()) as UepLedgerSnapshot, trust, {}, { zkSpendVerifier: v });
  const key = l.zkSlotKey(a.accountId, p.tx.assetId);
  assert.ok(r.zkBlindingOf(key).eq(nb));
  assert.ok(r.zkCircuitProjection(6).state.root().eq(l.zkCircuitProjection(6).state.root()));
});

test("legacy v5 payloads: refused for new submissions by default, accepted with zkAcceptLegacyV5", async () => {
  const v = registry();
  const { l, a, b } = await setup(v, { zkRootBinding: "off" });
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  const pi12 = v6Inputs(l, p.tx, Fr.zero()).slice(0, 12); pi12[11] = p.tx.transactionCommitment.toHex();
  v.ok.add(`v5|${pi12.join(",")}`);
  const tx5 = zk(p.tx, pi12, "v5");
  assert.equal(zkPayloadVersion(parseZkSpendPayload(tx5.spendProof)!), 5);
  assert.match(msg(l.submit(tx5)), /legacy v5 format/);
  const { l: l2, a: a2, b: b2 } = await setup(v, { zkRootBinding: "off", zkAcceptLegacyV5: true });
  const p2 = l2.prepareSpend(a2, b2.accountId, EUR, 1_000n);
  assert.ok("tx" in p2);
  const q = v6Inputs(l2, p2.tx, Fr.zero()).slice(0, 12); q[11] = p2.tx.transactionCommitment.toHex();
  v.ok.add(`v5b|${q.join(",")}`);
  assert.equal(code(l2.submit(zk(p2.tx, q, "v5b"))), "OK");
  // historical v5 txs keep re-verifying on restore without the flag
  const r = UepLedger.restore(structuredClone(l2.snapshot()) as UepLedgerSnapshot, trust, {}, { zkSpendVerifier: v, zkRootBinding: "off" });
  assert.equal(r.balanceOfAsset(b2.accountId, EUR), 1_000n);
});

test("root binding: on by default; 'off' refused under production", async () => {
  const v = registry();
  const { l, a, b } = await setup(v);
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  const nb = new Fr(9n);
  const pi = v6Inputs(l, p.tx, nb); pi[0] = "0x1234"; pi[11] = circuitTxCommitmentOf(pi).toHex();
  v.ok.add(`b|${pi.join(",")}`);
  assert.match(msg(l.submit(zk(p.tx, pi, "b", nb))), /projected ledger roots/);
  assert.throws(() => assertRootBindingAllowed("off", true), /ZK_ROOT_BINDING_OFF_IN_PRODUCTION/);
  assert.doesNotThrow(() => assertRootBindingAllowed("off", false));
  assert.doesNotThrow(() => assertRootBindingAllowed("circuit-projection", true));
});
