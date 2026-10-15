/**
 * 0.5.83: end to end with real Groth16 proofs (development keys, circuit v6, depth 4):
 * a zk account (H_ACCOUNT id, linked to its Ed25519 account) spends on the ledger,
 * the spend is accepted, a replay and a reused nullifier are rejected, and the
 * snapshot restores with the proofs re-verified.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { identityFromMnemonic } from "../identity/index.ts";
import { UepLedger, type UepLedgerSnapshot } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";
import { Fr } from "../core/field.ts";
import { clientBlinding } from "../core/client-note.ts";
import { ledgerAssetIdToFr } from "../core/assets.ts";
import { signZkAccountLink, zkAccountIdOf, zkAccountLinkError } from "../core/zk-account.ts";
import { parseZkSpendPayload, zkBindingMismatches, zkRootMismatches, type ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import { zkProveSpendJson } from "./zk-bridge.ts";
import { zkAccountSpendRequest } from "./zk-account-spend.ts";
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

function realVerifier(): ZkSpendVerifier & { calls: number } {
  const r = runUepZk(["dev-vk-v6", "4"]);
  const vk = /vk_hex=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(vk, `dev-vk-v6 4 failed: ${r.stderr}`);
  return { keyMode: "development", calls: 0, verify(p) { this.calls++; return zkVerifyHex(vk!, p.proof, p.publicInputsHex).ok; } };
}

test("zk account: real proof accepted end to end; replay and reused nullifier rejected; restore re-verifies", async () => {
  assert.ok(findUepZkBinary(), "uep-zk binary required (scripts/build-uep-zk.sh)");
  const v = realVerifier();
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v, zkCircuitDepthV6: 4 });
  const a = await identityFromMnemonic(M1);
  const b = await identityFromMnemonic(M2);
  const asset = ledgerAssetIdToFr(EUR);
  const zkA = zkAccountIdOf(a.secret, a.salt), zkB = zkAccountIdOf(b.secret, b.salt);
  l.faucet(a.accountId, EUR, 10_000n, clientBlinding(91n));

  // Links: signed by the Ed25519 account key; a forged or foreign link is refused.
  const linkA = signZkAccountLink(a, l.networkId, l.domainId);
  assert.equal(zkAccountLinkError({ ...linkA, accountId: b.accountId.toHex() }, l.networkId, l.domainId), "ZK_LINK_OWNER_KEY");
  assert.equal(zkAccountLinkError(linkA, l.networkId, "MARS"), "ZK_LINK_SIGNATURE");
  assert.ok("ok" in l.linkZkAccount(linkA));
  assert.ok("ok" in l.linkZkAccount(signZkAccountLink(b, l.networkId, l.domainId)));
  assert.ok(l.zkAccountOf(a.accountId)!.eq(zkA));

  // Migration of an existing account: a signed transfer to its own zk account.
  const fund = l.prepareSpend(a, zkA, EUR, 5_000n);
  assert.ok("tx" in fund, "error" in fund ? String((fund as { error: { message: string } }).error.message) : "");
  assert.equal(code(l.submit(fund.tx)), "OK");
  assert.equal(l.balanceOfAsset(zkA, EUR), 5_000n);

  // Real proof: PI[4] = H_ACCOUNT, PI[10] = circuit nullifier = tx nullifier.
  const s1 = proveZkAccountSpend(l, a, zkB, asset, 1_000n);
  assert.ok(s1.ok, s1.ok ? "" : s1.error);
  assert.ok(s1.tx.senderId.eq(zkA));
  // EXP-098 cross-check: all 13 inputs agree with the ledger before the verifier runs.
  const p1 = parseZkSpendPayload(s1.tx.spendProof)!;
  assert.equal(p1.publicInputsHex.length, 13);
  assert.deepEqual(zkBindingMismatches(s1.tx, TREASURY_ID, p1, l.zkDomainId()), []);
  const t1 = l.zkTransitionFor(s1.tx, p1);
  assert.ok("ok" in t1);
  assert.deepEqual(zkRootMismatches(p1, t1.ok.roots), []);
  assert.ok(s1.tx.nullifier.eq(new Fr(BigInt(`0x${s1.publicInputsHex[10]!.replace(/^0x/, "")}`))));
  // A proof with the lab domain number (1) instead of the node's domain is refused on PI[12].
  const req1 = { ...zkAccountSpendRequest(l, a, zkB, asset, 1_000n, 4) } as Record<string, unknown>;
  delete req1.domain_fr;
  const art1 = zkProveSpendJson(req1 as never);
  assert.ok(art1.ok);
  const wrongDomain = l.zkAccountSpendTx({ recipientId: zkB, assetId: asset, amount: 1_000n, publicInputsHex: art1.publicInputsHex, proof: art1.proofHex!, senderNextBlinding: s1.senderNextBlinding });
  assert.match(msg(l.submit(wrongDomain)), /public inputs 12 do not match/);
  const r1 = l.submit(s1.tx);
  assert.equal(code(r1), "OK", msg(r1));
  assert.equal(l.balanceOfAsset(zkB, EUR), 1_000n);
  assert.equal(l.balanceOfAsset(zkA, EUR), 5_000n - 1_000n - s1.tx.fee);
  assert.ok(l.zkBlindingOf(l.zkSlotKey(zkA, asset)).eq(s1.senderNextBlinding));
  assert.ok(v.calls >= 1);

  // Replay of the same transaction, and the same nullifier in another transaction.
  assert.equal(code(l.submit(s1.tx)), "REPLAY");
  const reuse = l.zkAccountSpendTx({ recipientId: zkB, assetId: asset, amount: 999n, publicInputsHex: s1.publicInputsHex, proof: s1.proofHex, senderNextBlinding: s1.senderNextBlinding });
  assert.equal(code(l.submit(reuse)), "DOUBLE_SPEND");

  // Second spend from the same account: fresh nullifier, accepted.
  const s2 = proveZkAccountSpend(l, a, zkB, asset, 500n);
  assert.ok(s2.ok, s2.ok ? "" : s2.error);
  assert.ok(!s2.tx.nullifier.eq(s1.tx.nullifier));
  // A tampered public input fails (binding or verifier).
  const bad = [...s2.publicInputsHex]; bad[9] = Fr.from(77n).toHex();
  assert.equal(code(l.submit(l.zkAccountSpendTx({ recipientId: zkB, assetId: asset, amount: 500n, publicInputsHex: bad, proof: s2.proofHex, senderNextBlinding: s2.senderNextBlinding }))), "PROOF");
  assert.equal(code(l.submit(s2.tx)), "OK");

  // Restore: links re-verified, proofs re-verified, balances rebuilt.
  const snap = structuredClone(l.snapshot()) as UepLedgerSnapshot;
  const r = UepLedger.restore(structuredClone(snap), trust, {}, { zkSpendVerifier: v, zkCircuitDepthV6: 4 });
  assert.equal(r.balanceOfAsset(zkB, EUR), 1_500n);
  assert.ok(r.zkAccountOf(b.accountId)!.eq(zkB));
  assert.ok(r.zkCircuitProjection(6).state.root().eq(l.zkCircuitProjection(6).state.root()));
  const reject: ZkSpendVerifier = { keyMode: "development", verify: () => false };
  assert.throws(() => UepLedger.restore(structuredClone(snap), trust, {}, { zkSpendVerifier: reject, zkCircuitDepthV6: 4 }), /TX_ZK_PROOF/);
  const forged = structuredClone(snap) as UepLedgerSnapshot & { zkLinks: Array<{ signature: string }> };
  forged.zkLinks[0]!.signature = "00".repeat(64);
  assert.throws(() => UepLedger.restore(forged, trust, {}, { zkSpendVerifier: v, zkCircuitDepthV6: 4 }), /ZK_LINKS|SIGNATURE|HASH/);
});

test("zk account spend: shape and participant rules", async () => {
  const v: ZkSpendVerifier = { keyMode: "development", verify: () => true };
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: FAUCET.privateKey, zkSpendVerifier: v, zkCircuitDepthV6: 4 });
  const a = await identityFromMnemonic(M1);
  const asset = ledgerAssetIdToFr(EUR);
  const pis = Array.from({ length: 13 }, (_, i) => Fr.from(BigInt(i + 1)).toHex());
  pis[4] = zkAccountIdOf(a.secret, a.salt).toHex();
  // the treasury is never a recipient of a zk account spend (an Ed25519 recipient is the exit path)
  const tx = l.zkAccountSpendTx({ recipientId: TREASURY_ID, assetId: asset, amount: 10n, publicInputsHex: pis, proof: "00", senderNextBlinding: Fr.zero() });
  assert.equal(code(l.submit(tx)), "INVALID_PARTICIPANTS");
  // a key-derived id cannot be linked as a zk account
  const link = signZkAccountLink(a, l.networkId, l.domainId);
  const self = { ...link, zkAccountId: a.accountId.toHex() };
  assert.notEqual(zkAccountLinkError(self, l.networkId, l.domainId), undefined);
  assert.ok("ok" in l.linkZkAccount(link));
  assert.ok("ok" in l.linkZkAccount(link), "idempotent");
  const b = await identityFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  const other = signZkAccountLink({ ...b, accountId: a.accountId }, l.networkId, l.domainId);
  assert.ok("error" in l.linkZkAccount(other));
  assert.throws(() => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, zkCircuitDepthV6: 8 as 4 }), /ZK_DEPTH_INVALID/);
});
