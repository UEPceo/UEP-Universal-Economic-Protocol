/**
 * 0.5.83 exit path, real Groth16 proofs (development keys, circuit v6, depth 4):
 * a zk account pays a normal Ed25519 account. The recipient gets its ledger
 * balance plus the deterministic exit note, which it then spends with its own
 * signature. Replay, wrong recipient, tampered amount and substituted output
 * are rejected; total supply is conserved; restore re-verifies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { identityFromMnemonic } from "../identity/index.ts";
import { UepLedger, type UepLedgerSnapshot } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { clientBlinding } from "../core/client-note.ts";
import { ledgerAssetIdToFr } from "../core/assets.ts";
import { makeNote, serializeNote } from "../core/note.ts";
import { signZkAccountLink, zkAccountIdOf, zkExitNote } from "../core/zk-account.ts";
import type { ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { findUepZkBinary, runUepZk, zkVerifyHex } from "./zk-bridge.ts";
import { proveZkAccountSpend } from "./zk-account-spend.ts";

const SNAP = generateEd25519KeyPair();
const FAUCET = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const trust = { authorities: [SNAP.publicKeyHex], faucetPublicKeys: [FAUCET.publicKeyHex] };
const code = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.code : "OK");
const msg = (r: { error: { code: string; message: string } } | { tx: unknown }) => ("error" in r ? r.error.message : "");
const M1 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const M2 = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";

function realVerifier(depth: 4 | 64): ZkSpendVerifier & { calls: number } {
  const r = runUepZk(["dev-vk-v6", String(depth)]);
  const vk = /vk_hex=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(vk, `dev-vk-v6 ${depth} failed: ${r.stderr}`);
  return { keyMode: "development", calls: 0, verify(p) { this.calls++; return zkVerifyHex(vk!, p.proof, p.publicInputsHex).ok; } };
}

const total = (l: UepLedger) => l.snapshot().balances.reduce((t, [, v]) => t + BigInt(v as string), 0n);

test("zk exit: zk account pays an Ed25519 account; replay, wrong recipient, tampered amount rejected; supply conserved", async () => {
  assert.ok(findUepZkBinary(), "uep-zk binary required (scripts/build-uep-zk.sh)");
  const v = realVerifier(4);
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v, zkCircuitDepthV6: 4 });
  const a = await identityFromMnemonic(M1);
  const b = await identityFromMnemonic(M2);
  const asset = ledgerAssetIdToFr(EUR);
  const zkA = zkAccountIdOf(a.secret, a.salt);
  l.faucet(a.accountId, EUR, 10_000n, clientBlinding(91n));
  assert.ok("ok" in l.linkZkAccount(signZkAccountLink(a, l.networkId, l.domainId)));
  const fund = l.prepareSpend(a, zkA, EUR, 5_000n);
  assert.ok("tx" in fund);
  assert.equal(code(l.submit(fund.tx)), "OK");
  const supply = total(l);

  // Exit to b's normal account (b has never received anything: empty recipient slot).
  const s = proveZkAccountSpend(l, a, b.accountId, asset, 2_000n);
  assert.ok(s.ok, s.ok ? "" : s.error);
  assert.equal(s.tx.fee, creatorFee(2_000n, l.feeFloorOf(asset)));
  assert.equal(s.tx.outputCommitments.length, 1);
  assert.ok(s.tx.outputCommitments[0]!.eq(zkExitNote(b.accountId, asset, 2_000n, s.tx.nullifier).commitment));

  // Tampered amount (tx and PI[8]) and wrong recipient: binding or verifier refuse.
  const pis = (f: (p: string[]) => void) => { const p = [...s.publicInputsHex]; f(p); return p; };
  const tampered = l.zkAccountSpendTx({ recipientId: b.accountId, assetId: asset, amount: 2_500n, publicInputsHex: pis((p) => { p[8] = Fr.from(2_500n).toHex(); }), proof: s.proofHex, senderNextBlinding: s.senderNextBlinding });
  assert.equal(code(l.submit(tampered)), "PROOF");
  const other = await identityFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  const wrong = l.zkAccountSpendTx({ recipientId: other.accountId, assetId: asset, amount: 2_000n, publicInputsHex: s.publicInputsHex, proof: s.proofHex, senderNextBlinding: s.senderNextBlinding });
  assert.equal(code(l.submit(wrong)), "PROOF"); // new roots and PI[5] are bound to the proven recipient
  // Substituted output note (same commitment slot, another blinding).
  const sub = makeNote(b.accountId, asset, 2_000n, new Fr(12345n));
  const swapped: UepTransaction = { ...s.tx, outputCommitments: [sub.commitment], outputNotes: [serializeNote(sub)] };
  assert.notEqual(code(l.submit(swapped)), "OK");

  const r = l.submit(s.tx);
  assert.equal(code(r), "OK", msg(r));
  assert.equal(l.balanceOfAsset(b.accountId, EUR), 2_000n);
  assert.equal(l.balanceOfAsset(zkA, EUR), 5_000n - 2_000n - s.tx.fee);
  assert.equal(total(l), supply, "total supply conserved");
  assert.equal(code(l.submit(s.tx)), "REPLAY");
  const reuse = l.zkAccountSpendTx({ recipientId: b.accountId, assetId: asset, amount: 1_999n, publicInputsHex: s.publicInputsHex, proof: s.proofHex, senderNextBlinding: s.senderNextBlinding });
  assert.equal(code(l.submit(reuse)), "DOUBLE_SPEND");

  // The recipient spends the exit note with its own signature (normal note path).
  const out = l.prepareSpend(b, a.accountId, EUR, 1_000n);
  assert.ok("tx" in out, "error" in out ? String((out as { error: { message: string } }).error.message) : "");
  assert.equal(code(l.submit(out.tx)), "OK");
  assert.equal(total(l), supply);

  // Restore re-verifies the zk spend and accepts the exit note as a transaction output.
  const snap = structuredClone(l.snapshot()) as UepLedgerSnapshot;
  const re = UepLedger.restore(snap, trust, {}, { zkSpendVerifier: v, zkCircuitDepthV6: 4 });
  assert.equal(re.balanceOfAsset(b.accountId, EUR), l.balanceOfAsset(b.accountId, EUR));
  for (const x of [zkA, a.accountId, TREASURY_ID]) assert.equal(re.balanceOfAsset(x, EUR), l.balanceOfAsset(x, EUR));
  assert.ok(TREASURY_ID);
});

test("zk depth 64: real proof through submit() (opt-in: UEP_ZK_D64=1)", { skip: process.env.UEP_ZK_D64 !== "1" }, async () => {
  const t0 = performance.now();
  const v = realVerifier(64);
  const tVk = performance.now() - t0;
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v });
  const a = await identityFromMnemonic(M1);
  const b = await identityFromMnemonic(M2);
  const asset = ledgerAssetIdToFr(EUR);
  const zkA = zkAccountIdOf(a.secret, a.salt);
  l.faucet(a.accountId, EUR, 10_000n, clientBlinding(91n));
  assert.ok("ok" in l.linkZkAccount(signZkAccountLink(a, l.networkId, l.domainId)));
  const fund = l.prepareSpend(a, zkA, EUR, 5_000n);
  assert.ok("tx" in fund);
  assert.equal(code(l.submit(fund.tx)), "OK");
  const t1 = performance.now();
  const s = proveZkAccountSpend(l, a, b.accountId, asset, 1_000n, 64);
  const tProve = performance.now() - t1;
  assert.ok(s.ok, s.ok ? "" : s.error);
  const t2 = performance.now();
  const r = l.submit(s.tx);
  const tSubmit = performance.now() - t2;
  assert.equal(code(r), "OK", msg(r));
  assert.equal(code(l.submit(s.tx)), "REPLAY");
  const { createHash } = await import("node:crypto");
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const record = {
    test: "zk depth 64 real proof through submit()", depth: 64, node: process.version,
    ms: { devVk: Math.round(tVk), proveIncludingSetup: Math.round(tProve), submitIncludingVerify: Math.round(tSubmit) },
    vkSha256: createHash("sha256").update(Buffer.from(s.vkHex, "hex")).digest("hex"), proofSha256: sha(s.proofHex), publicInputsSha256: sha(s.publicInputsHex.join(",")),
    txId: s.tx.txId.toHex(), result: "OK", replay: "REPLAY",
  };
  console.log(`ZK_D64_RECORD ${JSON.stringify(record)}`);
});
