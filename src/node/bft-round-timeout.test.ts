/** 0.5.81 item 3: a height opened by an equivocating proposer is closed by a deterministic height-based round change. */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { clientBlinding } from "../core/client-note.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";
import { PeerNet, type Peer } from "./peer-net.ts";
import { BftConsensusKernel, type BftProposal, type BftValidator } from "./bft-consensus.ts";
import { BftRoundTimer, timeoutTicks } from "./bft-round-timer.ts";
import { txToWire } from "./certified-commit.ts";

const ASSET = "uep-test/teur";

test("round timer: deterministic, height-based, exponential, reset per height, no firing on a backwards producer", () => {
  const t = new BftRoundTimer({ baseTicks: 4, maxDoublings: 3 });
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(r => timeoutTicks(r, t.config)), [4, 8, 16, 32, 32, 32]);
  const fired: [number, number][] = [];
  for (let tick = 100; tick < 160; tick++) { const r = t.onTick(tick, 7); if (r !== undefined) fired.push([tick, r]); }
  assert.deepEqual(fired, [[104, 1], [112, 2], [128, 3]]);
  assert.equal(t.onTick(50, 7), undefined, "producer going backwards never fires");
  assert.equal(t.onTick(161, 8), undefined); assert.equal(t.current().round, 0, "new height resets");
  assert.equal(t.join(8, 2, 161), true); assert.equal(t.join(8, 1, 161), false);
  assert.throws(() => new BftRoundTimer({ baseTicks: 0, maxDoublings: 1 }), /CONFIG/);
});

test("an equivocating round-0 proposer leaves the height open; honest validators time out by height, change round and decide one block", async () => {
  const snapshotKey = generateEd25519KeyPair(), faucetKey = generateEd25519KeyPair();
  const vkeys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators: BftValidator[] = vkeys.map((k, i) => ({ id: `bft-${i}`, publicKeyHex: k.publicKeyHex }));
  const voters = new Map(validators.map(v => [v.id, v.publicKeyHex]));
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const fee = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const seed = assembleNode({ custody, feeAccount: fee, snapshotKey, faucetKey, noteBlindingDomain: 23n });
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(3n));
  seed.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(4n));
  const genesis = seed.ledger.snapshot();
  const trust = { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] };
  const keys = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };
  const nets = vkeys.map((k, i) => new PeerNet(`bft-${i}`, UepLedger.restore(genesis, trust, keys), k.privateKey, k.publicKeyHex, [], voters));
  nets.forEach(n => n.configureBftConsensus(new BftConsensusKernel({ networkId: n.ledger.networkId, domainId: n.ledger.domainId }, validators, 1)));
  const ports = await Promise.all(nets.map(n => n.listen(0)));
  const peers: Peer[] = ports.map((p, i) => ({ id: `bft-${i}`, url: `http://127.0.0.1:${p}` }));
  nets.forEach((n, i) => { n.peers = peers.filter(p => p.id !== `bft-${i}`); });
  try {
    const kernel = new BftConsensusKernel({ networkId: nets[0]!.ledger.networkId, domainId: nets[0]!.ledger.domainId }, validators, 1);
    const h = nets[0]!.bftOpenHeight();
    const byz = Number(kernel.leader(h, 0).slice(4));
    const honest = nets.filter((_, i) => i !== byz);
    const pay = (amount: bigint, b: bigint) => {
      const r = nets[byz]!.ledger.preparePayment(buyer, custody.accountId, ASSET, amount, nets[byz]!.ledger.height, { outputBlinding: clientBlinding(b), changeBlinding: clientBlinding(b + 1n) });
      if ("error" in r) throw new Error(r.error.code); return r.txs[0]!;
    };
    const txA = pay(1_000n, 50n), txB = pay(2_000n, 60n);
    const parentRoot = nets[0]!.ledger.stateRoot().toHex();
    // Round 0: the leader sends block A to two honest validators and block B to the third.
    const signedBy = nets[byz] as unknown as { signed(p: string, x: unknown): unknown };
    const sendProposal = async (to: number, tx: typeof txA) => {
      const p: BftProposal = { networkId: nets[0]!.ledger.networkId, domainId: nets[0]!.ledger.domainId, height: h, round: 0, proposerId: `bft-${byz}`, parentRoot, blockId: tx.txId.toHex() };
      const sig = kernel.signProposal(p, vkeys[byz]!.privateKey);
      const res = await fetch(peers[to]!.url + "/bft/proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signedBy.signed("/bft/proposal", { proposal: p, proposalSignature: sig, tx: txToWire(tx) })) });
      return res.status;
    };
    const targets = [0, 1, 2, 3].filter(i => i !== byz);
    for (const [k, to] of targets.entries()) assert.equal(await sendProposal(to, k < 2 ? txA : txB), 200);
    for (const n of honest) assert.equal(n.bftCommitStatus(h), "UNKNOWN", "no quorum in round 0: the height stays open");

    // Honest validators feed producer ticks; nobody decides in round 0, so all time out together.
    const sent: number[] = [];
    for (let tick = 1000; tick <= 1000 + timeoutTicks(0); tick++) for (const n of honest) if (await n.bftTick(tick)) sent.push(tick);
    assert.ok(sent.length >= 1 && sent.every(t => t === 1000 + timeoutTicks(0)), `round changes fire exactly at the timeout tick: ${sent}`);
    // If the round-1 leader is the faulty validator, round 1 times out too and round 2 has an honest leader.
    let tick = 1000 + timeoutTicks(0);
    while (nets[Number(kernel.leader(h, honest[0]!.bftRound()).slice(4))] === nets[byz]) {
      const until = tick + timeoutTicks(honest[0]!.bftRound());
      for (tick++; tick <= until; tick++) for (const n of honest) await n.bftTick(tick);
      tick = until;
    }
    const r = honest[0]!.bftRound();
    for (const n of honest) assert.equal(n.bftRound(), r);
    const leader = nets[Number(kernel.leader(h, r).slice(4))]!;
    const rc = leader.bftRoundChangeCertificate(h, r);
    assert.ok(rc && rc.messages.length >= 3, "quorum of round changes");
    const cert = await leader.bftProposeAfterRoundChange(txA);
    assert.equal(cert.phase, "precommit"); assert.equal(cert.blockId, txA.txId.toHex());
    const roots = honest.map(n => n.ledger.stateRoot().toHex());
    assert.equal(new Set(roots).size, 1);
    for (const n of honest) assert.equal(n.bftCommitStatus(h), "APPLIED");
    assert.equal(honest[0]!.bftOpenHeight(), h + 1, "the height is closed");
  } finally { await Promise.all(nets.map(n => n.close())); }
});
