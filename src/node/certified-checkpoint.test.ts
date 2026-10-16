/** 0.5.84 item 2: certified checkpoint verification and snapshot acceptance rules (single process). */
import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { acceptSnapshotAgainstCheckpoint, checkpointBodyFor, signCheckpoint, verifyCertifiedCheckpoint, type CertifiedCheckpoint, type CheckpointContext } from "./certified-checkpoint.ts";

const ASSET = "uep-test/teur";

async function fixture() {
  const snapshotKey = generateEd25519KeyPair(), faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: 61n });
  seed.ledger.faucet(buyer.accountId, ASSET, 50_050n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const fresh = () => UepLedger.restore(genesis, trust, keys);
  const pay = (l: UepLedger, i: number) => {
    const built = l.preparePayment(buyer, custody.accountId, ASSET, 100n + BigInt(i), l.height, { outputBlinding: clientBlinding(200n + BigInt(2 * i)), changeBlinding: clientBlinding(201n + BigInt(2 * i)) });
    if ("error" in built) throw new Error(built.error.code);
    for (const tx of built.txs) { const r = l.submit(tx); if ("error" in r) throw new Error(r.error.code); }
  };
  const vkeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const ref = fresh();
  const ctx: CheckpointContext = { networkId: ref.networkId, domainId: ref.domainId, validators: vkeys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex })), faultTolerance: 1 };
  const certify = (l: UepLedger, height: number, signers = [0, 1, 2]): CertifiedCheckpoint => {
    const body = checkpointBodyFor(ctx, height, l.txs.at(-1)!.txId.toHex(), l);
    return { body, signatures: signers.map(i => signCheckpoint(body, `v${i}`, vkeys[i]!.privateKey)) };
  };
  const restoreSnap = (l: UepLedger) => UepLedger.restore(l.snapshot(), trust, keys);
  return { fresh, pay, ctx, vkeys, certify, restoreSnap };
}

test("checkpoint: quorum of distinct validator signatures; duplicates, unknown signers and 2-of-4 are rejected", async () => {
  const f = await fixture();
  const l = f.fresh(); f.pay(l, 0);
  const cp = f.certify(l, 1);
  verifyCertifiedCheckpoint(cp, f.ctx);
  assert.throws(() => verifyCertifiedCheckpoint(f.certify(l, 1, [0, 1]), f.ctx), /CHECKPOINT_QUORUM_MISSING/);
  assert.throws(() => verifyCertifiedCheckpoint({ ...cp, signatures: [cp.signatures[0]!, cp.signatures[0]!, cp.signatures[1]!] }, f.ctx), /CHECKPOINT_QUORUM_MISSING/);
  const outsider = generateEd25519KeyPair();
  assert.throws(() => verifyCertifiedCheckpoint({ ...cp, signatures: [...cp.signatures.slice(0, 2), signCheckpoint(cp.body, "v9", outsider.privateKey)] }, f.ctx), /CHECKPOINT_QUORUM_MISSING/);
  assert.throws(() => verifyCertifiedCheckpoint({ ...cp, body: { ...cp.body, stateRoot: "22".repeat(32) } }, f.ctx), /CHECKPOINT_QUORUM_MISSING/);
});

test("checkpoint: another network, domain or validator set is CHECKPOINT_CONTEXT_MISMATCH", async () => {
  const f = await fixture();
  const l = f.fresh(); f.pay(l, 0);
  const cp = f.certify(l, 1);
  assert.throws(() => verifyCertifiedCheckpoint(cp, { ...f.ctx, networkId: "uep-other" }), /CHECKPOINT_CONTEXT_MISMATCH/);
  assert.throws(() => verifyCertifiedCheckpoint(cp, { ...f.ctx, domainId: "other" }), /CHECKPOINT_CONTEXT_MISMATCH/);
  assert.throws(() => verifyCertifiedCheckpoint(cp, { ...f.ctx, validators: f.ctx.validators.slice(0, 3) }), /CHECKPOINT_CONTEXT_MISMATCH/);
});

test("snapshot acceptance: a newer matching snapshot is accepted; stale, incompatible, conflicting and uncertified ones are rejected", async () => {
  const f = await fixture();
  const local = f.fresh(); f.pay(local, 0);
  const ahead = f.fresh(); f.pay(ahead, 0); f.pay(ahead, 1); f.pay(ahead, 2);
  const snap = f.restoreSnap(ahead);
  const cp = f.certify(ahead, 3);
  const localCp = f.certify(local, 1);
  acceptSnapshotAgainstCheckpoint(cp, f.ctx, snap, { ledger: local, lastCheckpoint: localCp });
  // stale: not above the last accepted checkpoint, or behind the local ledger
  assert.throws(() => acceptSnapshotAgainstCheckpoint(localCp, f.ctx, f.restoreSnap(local), { ledger: local, lastCheckpoint: localCp }), /CHECKPOINT_STALE/);
  assert.throws(() => acceptSnapshotAgainstCheckpoint(localCp, f.ctx, f.restoreSnap(local), { ledger: ahead }), /CHECKPOINT_STALE/);
  // incompatible: snapshot does not match the checkpoint
  const mid = f.fresh(); f.pay(mid, 0); f.pay(mid, 1);
  assert.throws(() => acceptSnapshotAgainstCheckpoint(cp, f.ctx, f.restoreSnap(mid), { ledger: local }), /CHECKPOINT_INCOMPATIBLE/);
  // conflict: this node applied the same height with another block
  assert.throws(() => acceptSnapshotAgainstCheckpoint(cp, f.ctx, snap, { ledger: local, appliedAt: () => ({ blockId: "ff".repeat(32), postRoot: null }) }), /CHECKPOINT_CONFLICT/);
  // without a valid certificate
  assert.throws(() => acceptSnapshotAgainstCheckpoint({ ...cp, signatures: cp.signatures.slice(0, 2) }, f.ctx, snap, { ledger: local }), /CHECKPOINT_QUORUM_MISSING/);
});
