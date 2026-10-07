/**
 * v0.5.3 crypto alignment: the ZK witness contract on the transaction path.
 * The ledger binds public inputs 4..11 of a zk-spend to the transaction before
 * calling the configured verifier; roots stay unbound (depth gap, documented);
 * development verifier keys are refused in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "./ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { hAccount } from "../core/hash.ts";
import { assertVerifierAllowed, circuitAccountId, circuitSlotIndex, zkTxBinding, ZK_BOUND_PUBLIC_INPUTS, type ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import type { UepTransaction } from "../core/transaction.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const code = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");

const stub = (keyMode: "development" | "ceremony" = "development"): ZkSpendVerifier & { calls: number } => ({
  keyMode,
  calls: 0,
  verify(p) { this.calls++; return p.proof === "valid-proof"; },
});

async function setup(verifier?: ZkSpendVerifier) {
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, ...(verifier ? { zkSpendVerifier: verifier } : {}) });
  const a = await identityFromMnemonic(await generateMnemonic(128));
  const b = await identityFromMnemonic(await generateMnemonic(128));
  l.faucet(a.accountId, EUR, 10_000n);
  const p = l.prepareSpend(a, b.accountId, EUR, 1_000n);
  assert.ok("tx" in p);
  return { l, tx: p.tx };
}

function withZk(tx: UepTransaction, proof = "valid-proof", tweak?: (pi: string[]) => void): UepTransaction {
  const pi = Array.from({ length: 12 }, () => "0x0");
  const bound = zkTxBinding(tx, TREASURY_ID);
  for (const i of ZK_BOUND_PUBLIC_INPUTS) pi[i] = bound[i];
  tweak?.(pi);
  return { ...tx, spendProof: { kind: "zk-spend", backend: "groth16-bn254", payload: JSON.stringify({ publicInputsHex: pi, proof }) } };
}

test("zk-spend without a configured verifier is refused", async () => {
  const { l, tx } = await setup();
  assert.equal(code(l.submit(withZk(tx))), "PROOF");
});

test("zk-spend: bound public inputs, then the verifier; sender signature still required", async () => {
  const v = stub();
  const { l, tx } = await setup(v);
  const r1 = l.submit(withZk(tx, "valid-proof", (pi) => { pi[8] = "0x1"; }));
  assert.equal(code(r1), "PROOF");
  assert.match("error" in r1 ? r1.error.message : "", /public inputs 8/);
  assert.equal(v.calls, 0); // binding is checked before the verifier runs
  assert.equal(code(l.submit(withZk(tx, "forged"))), "PROOF");
  assert.equal(code(l.submit({ ...withZk(tx), spendProof: { kind: "zk-spend", backend: "x", payload: "{" } })), "PROOF");
  const { senderAuth: _s, ...unsigned } = withZk(tx);
  assert.equal(code(l.submit(unsigned as UepTransaction)), "SENDER_AUTH");
  // Roots (0..3) are not bound: any value passes the binding check (documented gap).
  assert.equal(code(l.submit(withZk(tx, "valid-proof", (pi) => { pi[0] = "0x1234"; }))), "OK");
});

test("development verifier keys are refused in production; ceremony keys allowed", () => {
  assert.throws(() => assertVerifierAllowed(stub("development"), true), /ZK_DEV_KEYS_IN_PRODUCTION/);
  assert.doesNotThrow(() => assertVerifierAllowed(stub("ceremony"), true));
  assert.doesNotThrow(() => assertVerifierAllowed(stub("development"), false));
  assert.throws(() => assertVerifierAllowed({ keyMode: "other" as "ceremony", verify: () => true }, false), /ZK_VERIFIER_KEY_MODE/);
});

test("adapter: circuit account id and circuit slot index", () => {
  const s = new Fr(11n), salt = new Fr(22n);
  assert.ok(circuitAccountId(s, salt).eq(hAccount(s, salt)));
  const key = new Fr((5n << 40n) | 0xdeadbeefn);
  assert.equal(circuitSlotIndex(key), 0xdeadbeefn);
  assert.equal(circuitSlotIndex(key, 8), 0xefn);
  assert.throws(() => circuitSlotIndex(key, 0), /ZK_DEPTH_INVALID/);
});
