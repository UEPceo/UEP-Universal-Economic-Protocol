/**
 * v0.4.7 multi-asset ledger: canonical asset ids, per-asset conservation
 * through snapshot / restore / restoreChain, asset isolation of every spend,
 * per-asset issuance authority (scoping, rotation, revocation), per-asset
 * policy limits and fee floors, atomic multi-note payments and the fixed
 * requireProof flag.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "../core/field.ts";
import { hLeaf } from "../core/hash.ts";
import { encodeStringToFr } from "../core/encoding.ts";
import { makeNote, serializeNote, deserializeNote } from "../core/note.ts";
import { creatorFee, effectiveFeeBps, maxPayableFromNote, MIN_PROTOCOL_FEE } from "../core/fee.ts";
import { GLOBAL_ASSETS, INTERPLANETARY_ASSETS, TESTNET_ASSETS, ledgerAssetIdToFr, validateAssetRegistry } from "../core/assets.ts";
import { SecurityPolicy } from "../core/security-policy.ts";
import { generateEd25519KeyPair, signEd25519 } from "../core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { MAX_PAYMENT_PARTS, UepLedger, checkSpendShape, mintMessage, protocolFeeFloor, signSnapshot, type SnapshotTrust, type UepLedgerSnapshot } from "./ledger.ts";
import { TESTNET, TREASURY_ID } from "../network/profiles.ts";

const SNAPSHOT_KEY = generateEd25519KeyPair();
const FAUCET_KEY = generateEd25519KeyPair();
const TRUST: SnapshotTrust = { authorities: [SNAPSHOT_KEY.publicKeyHex], faucetPublicKeys: [FAUCET_KEY.publicKeyHex] };
const ASSETS = TESTNET_ASSETS.map((a) => a.assetId);
const EUR = "uep-test/teur";
const BTC = "uep-test/tbtc";
const fr = (a: string) => encodeStringToFr(a);

type LedgerOpts = Partial<ConstructorParameters<typeof UepLedger>[0]>;
const ledger = (extra: LedgerOpts = {}) =>
  new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey, ...extra });
const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const code = (r: { error: { code: string } } | object) => ("error" in r ? (r as { error: { code: string } }).error.code : "OK");
const resign = (snap: UepLedgerSnapshot) => signSnapshot(snap, [SNAPSHOT_KEY.privateKey]);
function relaxPolicy(l: UepLedger) {
  l.policy.config.maxTxPerWindow = 1_000_000;
  l.policy.config.maxTransferPerWindow = 10n ** 18n;
}
function spend(l: UepLedger, from: IdentitySecrets, to: Fr, asset: string, amount: bigint): UepTransaction {
  const p = l.prepareSpend(from, to, asset, amount);
  assert.ok("tx" in p, "error" in p ? p.error.message : "");
  return (p as { tx: UepTransaction }).tx;
}

/** supply(a) = sum of balances(a) (treasury included), for every registered asset. */
function assertPerAssetConservation(l: UepLedger) {
  for (const a of ASSETS) {
    const hex = fr(a).toHex();
    let sum = 0n;
    for (const [k, v] of l.balances) if (k.split("|")[1] === hex) sum += v;
    assert.equal(sum, l.supply.get(hex) ?? 0n, `conservation of ${a}`);
  }
}

/** Inject a mint record + note + balance, as a dishonest node would, signed with `key`. */
function injectMint(l: UepLedger, account: Fr, assetFr: Fr, amount: bigint, key: Parameters<typeof signEd25519>[1]) {
  const note = makeNote(account, assetFr, amount, hLeaf(account, new Fr(900_000n + BigInt(l.mints.length))));
  const unsigned = { index: l.mints.length, networkId: l.networkId, domainId: l.domainId, account: account.toHex(), assetId: assetFr.toHex(), amount: amount.toString(), commitment: note.commitment.toHex() };
  l.mints.push({ ...unsigned, signature: signEd25519(mintMessage(unsigned), key) });
  (l as any).addNote(note);
  (l as any).setBalance(account, assetFr, l.balanceOf(account, assetFr) + amount);
  l.supply.set(assetFr.toHex(), (l.supply.get(assetFr.toHex()) ?? 0n) + amount);
}

// ---------------------------------------------------------------- asset ids

test("asset ids: registries are canonical and their field encodings are distinct", () => {
  for (const reg of [TESTNET_ASSETS, GLOBAL_ASSETS, INTERPLANETARY_ASSETS]) assert.deepEqual(validateAssetRegistry(reg), []);
  const all = [...TESTNET_ASSETS, ...GLOBAL_ASSETS, ...INTERPLANETARY_ASSETS].map((a) => ledgerAssetIdToFr(a.assetId).toHex());
  assert.equal(new Set(all).size, all.length);
  for (const bad of ["\u0000uep-test/teur", "uep-test/teur\u0000", "Uep-test/teur", "uep-test/tést", "asset:test:usd", "uep-test", "uep-test/", "/teur", "a/b/c", "a".repeat(16) + "/x", "x/" + "a".repeat(16), "", "uep test/x", "uep|test/x"]) {
    assert.throws(() => ledgerAssetIdToFr(bad), /ASSET_ID_INVALID/, JSON.stringify(bad));
  }
  assert.ok(ledgerAssetIdToFr("a".repeat(15) + "/" + "b".repeat(15)));
  // v0.5.0 compatibility: a pre-v0.5.0 id is an alias of its namespaced id (docs/COMPATIBILITY.md).
  assert.ok(ledgerAssetIdToFr("asset:test:eur").eq(ledgerAssetIdToFr("uep-test/teur")));
  assert.ok(validateAssetRegistry([{ ...TESTNET_ASSETS[0]!, decimals: 9 }]).some((p) => /decimals/.test(p)));
  assert.ok(validateAssetRegistry([...TESTNET_ASSETS, { ...TESTNET_ASSETS[0]! }]).some((p) => /duplicate/.test(p)));
  assert.ok(validateAssetRegistry([{ ...TESTNET_ASSETS[0]!, decimals: 19 }]).some((p) => /decimals/.test(p)));
  assert.ok(validateAssetRegistry([{ ...TESTNET_ASSETS[0]!, minProtocolFee: 0n }]).some((p) => /minProtocolFee/.test(p)));
});

test("asset ids: unregistered or non-canonical assets are refused by faucet and prepareSpend", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  assert.throws(() => l.faucet(a.accountId, "uep-test/unregistered", 10n), /Unknown TESTNET asset/);
  assert.throws(() => l.faucet(a.accountId, "\u0000uep-test/teur", 10n), /Unknown TESTNET asset/);
  l.faucet(a.accountId, EUR, 1_000n);
  assert.equal(code(l.prepareSpend(a, b.accountId, "\u0000uep-test/teur", 10n)), "ASSET_MISMATCH");
  assert.equal(code(l.prepareSpend(a, b.accountId, "uep-global/eur", 10n)), "ASSET_MISMATCH");
});

// ---------------------------------------------------------------- conservation

test("conservation: random spends over 4 assets and 4 accounts conserve every asset through snapshot, restore and restoreChain", async () => {
  const ids = await Promise.all([0, 1, 2, 3].map(() => identity()));
  const l = ledger();
  relaxPolicy(l);
  for (const id of ids) for (const a of ASSETS) for (let k = 0; k < 6; k++) l.faucet(id.accountId, a, 15_000n);
  let seed = 11;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const snaps: UepLedgerSnapshot[] = [];
  let accepted = 0;
  const rejected = new Map<string, number>();
  let batches = 0;
  const feesByAsset = new Map<string, bigint>();
  for (let i = 0; i < 100; i++) {
    const s = rnd(4), r = (s + 1 + rnd(3)) % 4, a = ASSETS[rnd(ASSETS.length)]!;
    const amount = BigInt(1 + rnd(20_000));
    const p = l.prepareSpend(ids[s]!, ids[r]!.accountId, a, amount);
    // Fragmented balances pay through an atomic multi-note batch.
    const q = "tx" in p ? { txs: [p.tx] } : l.preparePayment(ids[s]!, ids[r]!.accountId, a, amount);
    if (!("txs" in q)) { rejected.set(q.error.code, (rejected.get(q.error.code) ?? 0) + 1); continue; }
    const parts = q.txs;
    const res = parts.length === 1 ? l.submit(parts[0]!, ids[s]!) : l.submitBatch(parts, ids[s]!);
    assert.equal(code(res), "OK");
    accepted++;
    if (parts.length > 1) batches++;
    for (const t of parts) feesByAsset.set(a, (feesByAsset.get(a) ?? 0n) + t.fee);
    if (i === 50) snaps.push(l.snapshot());
  }
  assert.ok(accepted >= 85, JSON.stringify([...rejected]));
  assert.ok(batches > 0);
  assertPerAssetConservation(l);
  // Fees of each asset stay in that asset's treasury balance.
  for (const a of ASSETS) assert.equal(l.balanceOf(TREASURY_ID, fr(a)), feesByAsset.get(a) ?? 0n, `treasury ${a}`);
  snaps.push(l.snapshot());
  const restored = UepLedger.restore(structuredClone(snaps[1]!), TRUST);
  const chained = UepLedger.restoreChain(structuredClone(snaps), TRUST);
  for (const r of [restored, chained]) {
    assertPerAssetConservation(r);
    for (const id of ids) for (const a of ASSETS) assert.equal(r.balanceOf(id.accountId, fr(a)), l.balanceOf(id.accountId, fr(a)));
  }
});

// ---------------------------------------------------------------- isolation

test("isolation: a relabelled asset, an input note of another asset and an output in another asset are rejected", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 10_000n);
  l.faucet(a.accountId, BTC, 10_000n);
  const tx = spend(l, a, b.accountId, EUR, 1_000n);
  // tx asset relabelled to another registered asset
  assert.equal(code(l.submit({ ...tx, assetId: fr(BTC) }, a)), "ASSET_MISMATCH");
  // output note in another asset
  const outs = tx.outputNotes!.map(deserializeNote);
  const btcOut = makeNote(outs[0]!.owner, fr(BTC), outs[0]!.amount, outs[0]!.blinding);
  assert.equal(code(l.submit({ ...tx, outputNotes: [serializeNote(btcOut), ...tx.outputNotes!.slice(1)] }, a)), "ASSET_MISMATCH");
  // input note of another asset
  const btcNote = l.notesOf(a.accountId).find((n) => n.assetId.eq(fr(BTC)))!;
  assert.equal(code(l.submit({ ...tx, inputNotes: [serializeNote(btcNote)] }, a)), "ASSET_MISMATCH");
  // the shared shape rule (submit, pending, restore) on its own
  assert.equal(checkSpendShape(tx, [btcNote], outs)?.code, "ASSET_MISMATCH");
  assert.equal(checkSpendShape(tx, tx.inputNotes!.map(deserializeNote), [btcOut, ...outs.slice(1)])?.code, "OUTPUT_BINDING");
  assert.equal(l.txs.length, 0);
  assert.equal(code(l.submit(tx, a)), "OK");
  assert.equal(l.balanceOf(a.accountId, fr(BTC)), 10_000n);
  assertPerAssetConservation(l);
});

// ---------------------------------------------------------------- issuance

test("issuance: restore rejects mints and notes of assets that are not registered", async () => {
  const a = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 10n);
  injectMint(l, a.accountId, fr("uep-test/unregistered"), 5_000n, FAUCET_KEY.privateKey);
  assert.throws(() => UepLedger.restore(structuredClone(l.snapshot()), TRUST), /INVALID_SNAPSHOT_(NOTE|MINT)_ASSET/);
  const l2 = ledger();
  l2.faucet(a.accountId, EUR, 10n);
  injectMint(l2, a.accountId, fr("uep-global/eur"), 5_000n, FAUCET_KEY.privateKey);
  assert.throws(() => UepLedger.restore(structuredClone(l2.snapshot()), TRUST), /INVALID_SNAPSHOT_(NOTE|MINT)_ASSET/);
});

test("issuance: a per-asset issuer key is the only key that mints its asset", async () => {
  const a = await identity();
  const BTC_ISSUER = generateEd25519KeyPair();
  const l = ledger({ issuerSigningKeys: { [BTC]: BTC_ISSUER.privateKey } });
  assert.deepEqual(l.issuerPublicKeys(), { [BTC]: BTC_ISSUER.publicKeyHex });
  l.faucet(a.accountId, EUR, 100n);
  l.faucet(a.accountId, BTC, 100n);
  const scoped: SnapshotTrust = { ...TRUST, issuerKeys: [{ publicKey: BTC_ISSUER.publicKeyHex, assetIds: [BTC] }] };
  const snap = l.snapshot();
  const r = UepLedger.restore(structuredClone(snap), scoped);
  assert.equal(r.balanceOf(a.accountId, fr(BTC)), 100n);
  // Without the issuer key in the trust anchors the BTC mint does not verify.
  assert.throws(() => UepLedger.restore(structuredClone(snap), TRUST), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  // A BTC mint signed by the general faucet key is refused once BTC has a scoped issuer.
  const l2 = ledger({ issuerSigningKeys: { [BTC]: BTC_ISSUER.privateKey } });
  l2.faucet(a.accountId, BTC, 100n);
  injectMint(l2, a.accountId, fr(BTC), 1_000n, FAUCET_KEY.privateKey);
  assert.throws(() => UepLedger.restore(structuredClone(l2.snapshot()), scoped), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  // The BTC issuer cannot mint EUR.
  const l3 = ledger();
  l3.faucet(a.accountId, EUR, 100n);
  injectMint(l3, a.accountId, fr(EUR), 1_000n, BTC_ISSUER.privateKey);
  assert.throws(() => UepLedger.restore(structuredClone(l3.snapshot()), scoped), /INVALID_SNAPSHOT_MINT_SIGNATURE/);
  // Issuer keys must be distinct from snapshot authority keys, and trusted when handed to a restored node.
  assert.throws(() => ledger({ issuerSigningKeys: { [BTC]: SNAPSHOT_KEY.privateKey } }), /ISSUER_KEY_NOT_DISTINCT/);
  assert.throws(() => ledger({ issuerSigningKeys: { "uep-test/nope": BTC_ISSUER.privateKey } }), /ISSUER_ASSET_UNKNOWN/);
  assert.throws(() => UepLedger.restore(structuredClone(snap), scoped, { issuerSigningKeys: { [EUR]: BTC_ISSUER.privateKey } }), /ISSUER_KEY_NOT_TRUSTED/);
  const resumed = UepLedger.restore(structuredClone(snap), scoped, { snapshotSigningKeys: [SNAPSHOT_KEY.privateKey], faucetSigningKey: FAUCET_KEY.privateKey, issuerSigningKeys: { [BTC]: BTC_ISSUER.privateKey } });
  resumed.faucet(a.accountId, BTC, 1n);
  assert.equal(resumed.balanceOf(a.accountId, fr(BTC)), 101n);
  assert.throws(() => UepLedger.restore(structuredClone(snap), { ...scoped, issuerKeys: [{ publicKey: SNAPSHOT_KEY.publicKeyHex, assetIds: [BTC] }] }), /INVALID_SNAPSHOT_TRUST/);
});

test("issuance: rotation and revocation of a mint key take effect from a mint index, also through restoreChain", async () => {
  const a = await identity();
  const NEXT = generateEd25519KeyPair();
  const l = ledger();
  l.faucet(a.accountId, EUR, 10n); // mint 0, faucet key
  l.faucet(a.accountId, EUR, 20n); // mint 1, faucet key
  const before = l.snapshot();
  l.setIssuerSigningKey(EUR, NEXT.privateKey); // rotation at mint index 2
  l.faucet(a.accountId, EUR, 30n); // mint 2, new key
  l.faucet(a.accountId, BTC, 40n); // mint 3, faucet key (BTC not rotated)
  const after = l.snapshot();
  const rotated: SnapshotTrust = {
    ...TRUST,
    issuerKeys: [{ publicKey: FAUCET_KEY.publicKeyHex, assetIds: [EUR] }, { publicKey: NEXT.publicKeyHex, assetIds: [EUR], fromMintIndex: 2 }],
    revokedMintKeys: [],
  };
  // The faucet key keeps minting BTC; EUR rotation from index 2.
  const chain = UepLedger.restoreChain(structuredClone([before, after]), rotated);
  assert.equal(chain.balanceOf(a.accountId, fr(EUR)), 60n);
  assert.equal(chain.balanceOf(a.accountId, fr(BTC)), 40n);
  // The new key is not valid before its start index.
  const early: SnapshotTrust = { ...rotated, issuerKeys: [{ publicKey: FAUCET_KEY.publicKeyHex, assetIds: [EUR] }, { publicKey: NEXT.publicKeyHex, assetIds: [EUR], fromMintIndex: 3 }] };
  assert.throws(() => UepLedger.restore(structuredClone(after), early), /INVALID_SNAPSHOT_MINT_SIGNATURE: mint 2/);
  // Revoking the faucet key from index 2: earlier mints stay valid, a later faucet-signed mint does not.
  const revoked: SnapshotTrust = { ...TRUST, issuerKeys: [{ publicKey: NEXT.publicKeyHex, assetIds: [EUR], fromMintIndex: 2 }, { publicKey: FAUCET_KEY.publicKeyHex, assetIds: [EUR] }], revokedMintKeys: [{ publicKey: FAUCET_KEY.publicKeyHex, fromMintIndex: 4 }] };
  assert.equal(UepLedger.restore(structuredClone(after), revoked).balanceOf(a.accountId, fr(EUR)), 60n);
  injectMint(l, a.accountId, fr(EUR), 1_000n, FAUCET_KEY.privateKey); // mint 4, revoked key
  assert.throws(() => UepLedger.restore(resign(structuredClone(l.snapshotPayload()) as UepLedgerSnapshot), revoked), /INVALID_SNAPSHOT_MINT_SIGNATURE: mint 4/);
  // A revoked key is not accepted as the restored node's faucet key.
  assert.throws(() => UepLedger.restore(structuredClone(after), { ...TRUST, revokedMintKeys: [{ publicKey: FAUCET_KEY.publicKeyHex, fromMintIndex: 4 }] }, { faucetSigningKey: FAUCET_KEY.privateKey }), /FAUCET_KEY_NOT_TRUSTED/);
  // Removing the issuer key falls back to the faucet key for new mints.
  l.setIssuerSigningKey(EUR, null);
  assert.deepEqual(l.issuerPublicKeys(), {});
});

// ---------------------------------------------------------------- policy

test("policy: window volume is tracked per asset and limits can be set per asset", async () => {
  const p = new SecurityPolicy({ maxTransferPerWindow: 1_000n, assetLimits: { [BTC]: { maxTransferAmount: 500n }, "uep-test/tenergy": { minTransferAmount: 10n } } });
  const probe = (assetId: string, amount: bigint) => ({ accountHex: "ab", assetId, amount, fee: 1n, nowMs: 1_000 });
  assert.equal(p.check(probe(EUR, 900n), true).ok, true);
  assert.equal(p.check(probe(BTC, 400n), true).ok, true); // EUR volume does not count against BTC
  assert.deepEqual(p.check(probe(EUR, 200n)), { ok: false, code: "WINDOW_VOLUME", message: "Rolling window volume cap exceeded." });
  assert.equal((p.check(probe(BTC, 600n)) as { code?: string }).code, "AMOUNT_CAP");
  assert.equal((p.check(probe("uep-test/tenergy", 9n)) as { code?: string }).code, "AMOUNT_TOO_SMALL");
  assert.equal(p.windowVolume("ab", EUR, 1_000), 900n);
  assert.equal(p.windowVolume("ab", BTC, 1_000), 400n);
  assert.deepEqual(p.limitsFor(EUR), { maxTransferAmount: 10_000_000n, maxTransferPerWindow: 1_000n, minTransferAmount: 0n });
  // checkSequence never mutates the window.
  assert.equal((p.checkSequence([probe(BTC, 300n), probe(BTC, 400n)]) as { code?: string }).code, "WINDOW_VOLUME");
  assert.equal(p.windowVolume("ab", BTC, 1_000), 400n);

  const a = await identity(); const b = await identity();
  const l = ledger();
  l.policy.config.maxTransferPerWindow = 2_000n;
  l.policy.setAssetLimits(BTC, { maxTransferPerWindow: 50_000n });
  l.faucet(a.accountId, EUR, 10_000n);
  l.faucet(a.accountId, BTC, 100_000n);
  assert.equal(code(l.submit(spend(l, a, b.accountId, EUR, 1_500n), a)), "OK");
  assert.equal(code(l.submit(spend(l, a, b.accountId, BTC, 40_000n), a)), "OK"); // not blocked by EUR volume
  assert.match((l.prepareSpend(a, b.accountId, EUR, 600n) as { error: { message: string } }).error.message, /WINDOW_VOLUME/);
  // Per-asset limits travel with the snapshot policy.
  const r = UepLedger.restore(structuredClone(l.snapshot()), TRUST);
  assert.deepEqual(r.policy.limitsFor(BTC), { maxTransferAmount: 10_000_000n, maxTransferPerWindow: 50_000n, minTransferAmount: 0n });
});

// ---------------------------------------------------------------- fees

test("fees: 0.1% for every asset, registry floor per asset (default 1 unit), exact single-note capacity", () => {
  assert.equal(MIN_PROTOCOL_FEE, 1n);
  for (const a of TESTNET_ASSETS) assert.equal(protocolFeeFloor(TESTNET.networkId, fr(a.assetId)), 1n);
  assert.equal(creatorFee(1n, 5n), 5n);
  assert.equal(creatorFee(10_000n, 5n), 10n);
  assert.equal(creatorFee(1_000_000n, 5n), 1_000n);
  assert.throws(() => creatorFee(10n, 0n), /minFee/);
  for (let x = 0n; x <= 5_000n; x++) {
    const p = maxPayableFromNote(x);
    if (p > 0n) assert.ok(p + creatorFee(p) <= x, `fits ${x}`);
    assert.ok(p + 1n + creatorFee(p + 1n) > x, `maximal ${x}`);
  }
  assert.equal(maxPayableFromNote(1n), 0n);
  assert.equal(maxPayableFromNote(10n ** 12n) + creatorFee(maxPayableFromNote(10n ** 12n)) <= 10n ** 12n, true);
  assert.equal(effectiveFeeBps(1_000_000n), 10n);
  assert.equal(effectiveFeeBps(1n), 10_000n); // 1-unit floor; per-asset bound pending the fee model decision
});

// ---------------------------------------------------------------- payments

test("payments: a payment no single note covers is paid atomically from several notes", async () => {
  const a = await identity(); const b = await identity();
  const l = ledger();
  l.faucet(a.accountId, EUR, 600n);
  l.faucet(a.accountId, EUR, 600n);
  l.faucet(a.accountId, EUR, 1n);
  l.faucet(a.accountId, BTC, 5_000n);
  assert.equal(code(l.prepareSpend(a, b.accountId, EUR, 1_000n)), "INSUFFICIENT");
  const plan = l.preparePayment(a, b.accountId, EUR, 1_000n);
  assert.ok("txs" in plan);
  assert.equal(plan.txs.length, 2);
  assert.equal(plan.txs.reduce((s, t) => s + t.amount, 0n), 1_000n);
  const res = l.submitBatch(plan.txs, a);
  assert.ok("txs" in res, JSON.stringify("error" in res ? res.error : ""));
  assert.equal(l.balanceOf(b.accountId, fr(EUR)), 1_000n);
  const fees = plan.txs.reduce((s, t) => s + t.fee, 0n);
  assert.equal(l.balanceOf(a.accountId, fr(EUR)), 1_201n - 1_000n - fees);
  assert.equal(l.balanceOf(TREASURY_ID, fr(EUR)), fees);
  assert.equal(l.balanceOf(a.accountId, fr(BTC)), 5_000n); // other assets untouched
  assertPerAssetConservation(l);
  const r = UepLedger.restore(structuredClone(l.snapshot()), TRUST);
  assert.equal(r.balanceOf(b.accountId, fr(EUR)), 1_000n);
  // A single note that covers the payment yields one ordinary spend.
  const one = l.preparePayment(b, a.accountId, EUR, 100n);
  assert.ok("txs" in one);
  assert.equal(one.txs.length, 1);
  // More than the notes can pay (one fee per note) is refused.
  assert.equal(code(l.preparePayment(a, b.accountId, EUR, 1_000n)), "INSUFFICIENT");
});

test("payments: a batch is all-or-nothing and its parts must share sender, asset and recipient", async () => {
  const a = await identity(); const b = await identity(); const c = await identity();
  const l = ledger();
  for (const v of [300n, 300n, 300n]) l.faucet(a.accountId, EUR, v);
  l.faucet(a.accountId, BTC, 1_000n);
  const plan = l.preparePayment(a, b.accountId, EUR, 800n);
  assert.ok("txs" in plan);
  assert.equal(plan.txs.length, 3);
  const before = { bal: l.balanceOf(a.accountId, fr(EUR)), root: l.stateRoot().toHex(), notes: l.notes.length };
  // Last part tampered: nothing is applied.
  const tampered = [...plan.txs.slice(0, 2), { ...plan.txs[2]!, senderAuth: { ...plan.txs[2]!.senderAuth!, signature: plan.txs[1]!.senderAuth!.signature } }];
  const bad = l.submitBatch(tampered, a);
  assert.ok("error" in bad);
  assert.equal(bad.index, 2);
  assert.equal(l.txs.length, 0);
  assert.equal(l.nullifiers.contains(plan.txs[0]!.nullifier), false);
  assert.deepEqual({ bal: l.balanceOf(a.accountId, fr(EUR)), root: l.stateRoot().toHex(), notes: l.notes.length }, before);
  // Structural rules.
  assert.equal(code(l.submitBatch([plan.txs[0]!, plan.txs[0]!], a)), "BATCH_INVALID");
  assert.equal(code(l.submitBatch([], a)), "BATCH_INVALID");
  const btc = spend(l, a, b.accountId, BTC, 100n);
  assert.equal(code(l.submitBatch([plan.txs[0]!, btc], a)), "BATCH_INVALID");
  const toC = spend(l, a, c.accountId, EUR, 100n);
  assert.equal(code(l.submitBatch([plan.txs[0]!, toC], a)), "BATCH_INVALID");
  // The policy is evaluated over the whole batch.
  l.policy.config.maxTxPerWindow = 2;
  assert.equal(code(l.submitBatch(plan.txs, a)), "POLICY");
  assert.equal(l.txs.length, 0);
  l.policy.config.maxTxPerWindow = 30;
  assert.ok("txs" in l.submitBatch(plan.txs, a));
  assert.equal(l.balanceOf(b.accountId, fr(EUR)), 800n);
  assert.equal(code(l.submitBatch(plan.txs, a)), "REPLAY");
  assert.ok(MAX_PAYMENT_PARTS >= 2);
  assertPerAssetConservation(l);
});

// ---------------------------------------------------------------- requireProof

test("requireProof is fixed at construction and always on after restore", async () => {
  const l = ledger();
  assert.equal(l.requireProof, true);
  assert.throws(() => { l.requireProof = false; }, /REQUIRE_PROOF_IMMUTABLE/);
  l.requireProof = true; // no-op
  assert.equal(l.requireProof, true);
  const t = ledger({ testOnlyDisableProof: true });
  assert.equal(t.requireProof, false);
  const a = await identity();
  t.faucet(a.accountId, EUR, 10n);
  assert.equal(UepLedger.restore(structuredClone(t.snapshot()), TRUST).requireProof, true);
});
