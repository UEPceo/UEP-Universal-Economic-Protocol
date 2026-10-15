/**
 * 0.5.81 item 2 compatibility: height-based vote-format activation. Two validators run the frozen
 * 0.5.80 kernel and two run 0.5.81 with voteV3ActivationHeight = 10. Below 10 they form mixed
 * certificates that both versions verify; from 10 on 0.5.81 speaks only v3 and refuses v2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftProposal } from "./bft-consensus.ts";
import { BftConsensusKernel as Kernel0580 } from "./bft-consensus-0580.fixture.ts";

const ACT = 10;
const keys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
const domain = { networkId: "uep-testnet", domainId: "EARTH" };
const hex = (n: number) => n.toString(16).padStart(64, "0");
type K = { createVote: Function; verifyVote: Function; voteCertificate: Function; verifyCertificate: Function; observePrevoteCertificate: Function; signProposal: Function; leader: Function; createRoundChange: Function; verifyRoundChange: Function };

function cluster() {
  const old0 = new Kernel0580(domain, validators, 1) as unknown as K, old1 = new Kernel0580(domain, validators, 1) as unknown as K;
  const new2 = new BftConsensusKernel(domain, validators, 1, undefined, { voteV3ActivationHeight: ACT }) as unknown as K;
  const new3 = new BftConsensusKernel(domain, validators, 1, undefined, { voteV3ActivationHeight: ACT }) as unknown as K;
  return [old0, old1, new2, new3];
}

function round(ks: K[], height: number) {
  const proposerId = ks[0]!.leader(height, 0) as string;
  const pk = keys[Number(proposerId.slice(1))]!.privateKey;
  const p: BftProposal = { ...domain, height, round: 0, proposerId, parentRoot: hex(height), blockId: hex(1000 + height) };
  const sig = ks[0]!.signProposal(p, pk) as string;
  const prevotes = ks.map((k, i) => k.createVote(p, "prevote", `v${i}`, keys[i]!.privateKey, sig));
  return { p, pk, sig, prevotes };
}

test("compat: below the activation height 0.5.80 and 0.5.81 validators sign identical-format votes and verify each other's certificates", () => {
  const ks = cluster();
  for (let h = 1; h < ACT; h++) {
    const { p, pk, prevotes } = round(ks, h);
    for (const k of ks) for (const v of prevotes) assert.equal(k.verifyVote(v), true, `h=${h}`);
    // Certificates built by either version verify on both.
    const certOld = ks[0]!.voteCertificate(h, 0, "prevote", p.blockId, prevotes);
    const certNew = ks[2]!.voteCertificate(h, 0, "prevote", p.blockId, prevotes);
    assert.equal(certNew.proposalHash, undefined);
    for (const k of ks) { assert.equal(k.verifyCertificate(certOld), true); assert.equal(k.verifyCertificate(certNew), true); }
    for (const k of ks) k.observePrevoteCertificate(certOld);
    const locked = { ...p, prevoteCertificate: certOld };
    const lsig = ks[0]!.signProposal(locked, pk);
    const precommits = ks.map((k, i) => k.createVote(locked, "precommit", `v${i}`, keys[i]!.privateKey, lsig));
    const commit = ks[3]!.voteCertificate(h, 0, "precommit", p.blockId, precommits);
    for (const k of ks) assert.equal(k.verifyCertificate(commit), true, `commit h=${h}`);
  }
  // Round changes below activation verify across versions too.
  const rcOld = ks[0]!.createRoundChange(ACT - 1, 1, "v0", keys[0]!.privateKey);
  const rcNew = ks[2]!.createRoundChange(ACT - 1, 1, "v2", keys[2]!.privateKey);
  for (const k of ks) { assert.equal(k.verifyRoundChange(rcOld), true); assert.equal(k.verifyRoundChange(rcNew), true); }
});

test("compat: from the activation height 0.5.81 signs only v3 and refuses v2; 0.5.80 cannot verify v3 (upgrade before activation)", () => {
  const ks = cluster();
  const { p, prevotes } = round(ks, ACT);
  const [v2a, v2b, v3a, v3b] = prevotes;
  assert.ok(v3a.proposalHash && v3a.epoch === 0 && v3a.validatorSetHash);
  assert.equal(v2a.proposalHash, undefined);
  for (const k of [ks[2]!, ks[3]!]) { assert.equal(k.verifyVote(v2a), false); assert.equal(k.verifyVote(v2b), false); assert.equal(k.verifyVote(v3a), true); }
  for (const k of [ks[0]!, ks[1]!]) assert.equal(k.verifyVote(v3a), false);
  // No quorum can mix formats at or above activation.
  assert.throws(() => ks[2]!.voteCertificate(ACT, 0, "prevote", p.blockId, prevotes), /QUORUM_NOT_MET/);
  // A v3 vote relabelled to a legacy height is refused (fields present at a v2 height).
  assert.equal(ks[2]!.verifyVote({ ...v3a, height: ACT - 1 }), false);
  // Stripping the v3 fields from a v3 vote does not yield a valid v2 vote (different signed bytes).
  const { epoch: _e, validatorSetHash: _s, proposalHash: _p, ...stripped } = v3a;
  assert.equal(ks[0]!.verifyVote(stripped), false);
});

test("compat: activation height 0 (default) is pure v3; invalid activation heights are refused", () => {
  const k = new BftConsensusKernel(domain, validators, 1);
  assert.equal(k.voteV3ActivationHeight, 0);
  assert.equal(k.isLegacyVoteHeight(1), false);
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => new BftConsensusKernel(domain, validators, 1, undefined, { voteV3ActivationHeight: bad }), /ACTIVATION_HEIGHT_INVALID/);
});
