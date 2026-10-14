import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { serializeTx, deserializeTx } from "../core/transaction.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { TxQuorum } from "./quorum.ts";
import { txNullifiers } from "../core/transaction.ts";

const ASSET = "uep-test/teur";

test("two nodes from the same snapshot accept the same client spend", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeA = await identityFromMnemonic(await generateMnemonic(128));
  const feeB = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, adminId: "admin-a", noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const snap = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const a = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, adminId: "admin-a", noteBlindingDomain: 7n, ledger: UepLedger.restore(snap, trust, keys) });
  const b = assembleNode({ custody, feeAccount: feeB, snapshotKey, faucetKey, adminId: "admin-b", noteBlindingDomain: 99n, ledger: UepLedger.restore(snap, trust, keys) });
  const built = a.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, a.ledger.height, {
    outputBlinding: clientBlinding(11n),
    changeBlinding: clientBlinding(12n),
  });
  if ("error" in built) throw new Error(built.error.code);
  const tx = deserializeTx(JSON.parse(JSON.stringify(serializeTx(built.txs[0]!), (_k, v) => typeof v === "bigint" ? { $b: v.toString() } : v), (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v));
  const appliedA = a.ledger.submit(tx);
  const appliedB = b.ledger.submit(deserializeTx(JSON.parse(JSON.stringify(serializeTx(tx), (_k, v) => typeof v === "bigint" ? { $b: v.toString() } : v), (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v)));
  if ("error" in appliedA || "error" in appliedB) throw new Error("TWO_NODE_REJECT");
  assert.equal(appliedA.tx.txId.toHex(), appliedB.tx.txId.toHex());
  assert.equal(a.ledger.stateRoot().toHex(), b.ledger.stateRoot().toHex());
  assert.notEqual(a.admin.identityId, b.admin.identityId);
});

test("a conflicting spend is rejected once the note is spent, and the two nodes diverge", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeA = await identityFromMnemonic(await generateMnemonic(128));
  const feeB = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const other = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const snap = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const a = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n, ledger: UepLedger.restore(snap, trust, keys) });
  const b = assembleNode({ custody, feeAccount: feeB, snapshotKey, faucetKey, noteBlindingDomain: 9n, ledger: UepLedger.restore(snap, trust, keys) });
  const first = a.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, a.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
  const second = b.ledger.preparePayment(buyer, other.accountId, ASSET, 2_000n, b.ledger.height, { outputBlinding: clientBlinding(21n), changeBlinding: clientBlinding(22n) });
  if ("error" in first || "error" in second) throw new Error("PREPARE_FAILED");
  const appliedA = a.ledger.submit(first.txs[0]!);
  const appliedB = b.ledger.submit(second.txs[0]!);
  if ("error" in appliedA || "error" in appliedB) throw new Error("APPLY_FAILED");
  assert.notEqual(a.ledger.stateRoot().toHex(), b.ledger.stateRoot().toHex());
  const replay = a.ledger.submit(first.txs[0]!);
  const cross = b.ledger.submit(first.txs[0]!);
  assert.equal("error" in replay && replay.error.code, "REPLAY");
  assert.equal("error" in cross && cross.error.code, "DOUBLE_SPEND");
});

test("a node behind catches up from the ahead node's snapshot", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeA = await identityFromMnemonic(await generateMnemonic(128));
  const feeB = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const ahead = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n, ledger: UepLedger.restore(genesis, trust, keys) });
  const behind = assembleNode({ custody, feeAccount: feeB, snapshotKey, faucetKey, noteBlindingDomain: 9n, ledger: UepLedger.restore(genesis, trust, keys) });
  const built = ahead.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, ahead.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
  if ("error" in built) throw new Error(built.error.code);
  const applied = ahead.ledger.submit(built.txs[0]!);
  if ("error" in applied) throw new Error(applied.error.code);
  assert.notEqual(ahead.ledger.stateRoot().toHex(), behind.ledger.stateRoot().toHex());
  const caught = assembleNode({ custody, feeAccount: feeB, snapshotKey, faucetKey, noteBlindingDomain: 9n, ledger: UepLedger.restore(ahead.ledger.snapshot(), trust, keys) });
  assert.equal(caught.ledger.stateRoot().toHex(), ahead.ledger.stateRoot().toHex());
  assert.equal(caught.ledger.height, ahead.ledger.height);
});

function copyTx(tx: ReturnType<typeof deserializeTx>) {
  return deserializeTx(JSON.parse(JSON.stringify(serializeTx(tx), (_k, v) => typeof v === "bigint" ? { $b: v.toString() } : v), (_k, v) => v && typeof v === "object" && typeof v.$b === "string" ? BigInt(v.$b) : v));
}

test("three nodes apply a spend only after two votes, and not the conflicting one", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = [generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()];
  const voters = new Map(voterKeys.map((key, i) => [`node-${i}`, key.publicKeyHex]));
  const quorum = new TxQuorum(voters, 2);
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fees = await Promise.all([0, 1, 2].map(() => generateMnemonic(128).then(identityFromMnemonic)));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const other = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fees[0]!, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nodes = fees.map((fee, i) => assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey, noteBlindingDomain: BigInt(7 + i), ledger: UepLedger.restore(genesis, trust, keys) }));
  const first = nodes[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nodes[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
  const second = nodes[2]!.ledger.preparePayment(buyer, other.accountId, ASSET, 2_000n, nodes[2]!.ledger.height, { outputBlinding: clientBlinding(21n), changeBlinding: clientBlinding(22n) });
  if ("error" in first || "error" in second) throw new Error("PREPARE_FAILED");
  const a = first.txs[0]!;
  const b = second.txs[0]!;
  const aNull = txNullifiers(a).map((id) => id.toHex());
  const votes = [0, 1].map((i) => quorum.vote(`node-${i}`, a.txId.toHex(), aNull, voterKeys[i]!.privateKey));
  assert.equal(quorum.confirm(a.txId.toHex(), aNull, votes).length, 2);
  assert.throws(() => quorum.confirm(b.txId.toHex(), txNullifiers(b).map((id) => id.toHex()), [quorum.vote("node-2", b.txId.toHex(), txNullifiers(b).map((id) => id.toHex()), voterKeys[2]!.privateKey)]), /QUORUM_NOT_MET|QUORUM_NULLIFIER_SPENT/);
  for (const node of nodes) {
    const applied = node.ledger.submit(copyTx(a));
    if ("error" in applied) throw new Error(applied.error.code);
  }
  assert.equal(nodes[0]!.ledger.stateRoot().toHex(), nodes[1]!.ledger.stateRoot().toHex());
  assert.equal(nodes[1]!.ledger.stateRoot().toHex(), nodes[2]!.ledger.stateRoot().toHex());
});

test("seven nodes confirm with five votes and tolerate two dissenting spends", async () => {
  const n = 7;
  const threshold = 5;
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const voterKeys = Array.from({ length: n }, () => generateEd25519KeyPair());
  const quorum = new TxQuorum(new Map(voterKeys.map((key, i) => [`node-${i}`, key.publicKeyHex])), threshold);
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fees = await Promise.all(Array.from({ length: n }, () => generateMnemonic(128).then(identityFromMnemonic)));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const other = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fees[0]!, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nodes = fees.map((fee, i) => assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey, noteBlindingDomain: BigInt(7 + i), ledger: UepLedger.restore(genesis, trust, keys) }));
  const first = nodes[0]!.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, nodes[0]!.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
  const second = nodes[6]!.ledger.preparePayment(buyer, other.accountId, ASSET, 2_000n, nodes[6]!.ledger.height, { outputBlinding: clientBlinding(21n), changeBlinding: clientBlinding(22n) });
  if ("error" in first || "error" in second) throw new Error("PREPARE_FAILED");
  const chosen = first.txs[0]!;
  const dissent = second.txs[0]!;
  const chosenNull = txNullifiers(chosen).map((id) => id.toHex());
  const votes = [0, 1, 2, 3, 4].map((i) => quorum.vote(`node-${i}`, chosen.txId.toHex(), chosenNull, voterKeys[i]!.privateKey));
  assert.equal(quorum.confirm(chosen.txId.toHex(), chosenNull, votes).length, threshold);
  const dissentVotes = [5, 6].map((i) => quorum.vote(`node-${i}`, dissent.txId.toHex(), txNullifiers(dissent).map((id) => id.toHex()), voterKeys[i]!.privateKey));
  assert.throws(() => quorum.confirm(dissent.txId.toHex(), txNullifiers(dissent).map((id) => id.toHex()), dissentVotes), /QUORUM_NOT_MET|QUORUM_NULLIFIER_SPENT/);
  for (const node of nodes) {
    const applied = node.ledger.submit(copyTx(chosen));
    if ("error" in applied) throw new Error(applied.error.code);
  }
  const root = nodes[0]!.ledger.stateRoot().toHex();
  assert.equal(nodes.every((node) => node.ledger.stateRoot().toHex() === root), true);
});

test("a drifted clock does not change acceptance of the same spend", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeA = await identityFromMnemonic(await generateMnemonic(128));
  const feeB = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const a = assembleNode({ custody, feeAccount: feeA, snapshotKey, faucetKey, noteBlindingDomain: 7n, ledger: UepLedger.restore(genesis, trust, keys) });
  const b = assembleNode({ custody, feeAccount: feeB, snapshotKey, faucetKey, noteBlindingDomain: 9n, ledger: UepLedger.restore(genesis, trust, keys) });
  const built = a.ledger.preparePayment(buyer, custody.accountId, ASSET, 1_000n, a.ledger.height, { outputBlinding: clientBlinding(11n), changeBlinding: clientBlinding(12n) });
  if ("error" in built) throw new Error(built.error.code);
  const appliedA = a.ledger.submit(copyTx(built.txs[0]!));
  if ("error" in appliedA) throw new Error(appliedA.error.code);
  const real = Date.now;
  Date.now = () => 0;
  try {
    const appliedB = b.ledger.submit(copyTx(built.txs[0]!));
    if ("error" in appliedB) throw new Error(appliedB.error.code);
  } finally {
    Date.now = real;
  }
  assert.equal(a.ledger.stateRoot().toHex(), b.ledger.stateRoot().toHex());
});
