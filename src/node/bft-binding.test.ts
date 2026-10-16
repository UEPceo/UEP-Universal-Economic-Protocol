/** Item 2 (0.5.81): votes bind epoch, validator-set configuration and the full proposal core. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftProposal } from "./bft-consensus.ts";
import { createDurableBftConsensusKernel } from "./bft-durable-store.ts";

const hex = (c: string) => c.repeat(64).slice(0, 64);
function fx(epoch = 0) {
  const keys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
  const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  const domain = { networkId: "uep-testnet-1", domainId: "EARTH", epoch };
  return { keys, validators, domain, kernel: new BftConsensusKernel(domain, validators, 1) };
}
const prop = (k: BftConsensusKernel, over: Partial<BftProposal> = {}): BftProposal =>
  ({ networkId: k.domain.networkId, domainId: k.domain.domainId, ...(k.epoch ? { epoch: k.epoch } : {}), height: 1, round: 0, proposerId: k.leader(1, 0), parentRoot: hex("0"), blockId: hex("a"), ...over });
const sign = (k: BftConsensusKernel, keys: ReturnType<typeof fx>["keys"], p: BftProposal) => k.signProposal(p, keys[Number(p.proposerId.slice(1))]!.privateKey);

test("item 2: a vote of another epoch does not verify, and a proposal of another epoch is refused", () => {
  const a = fx(0);
  const b = new BftConsensusKernel({ ...a.domain, epoch: 1 }, a.validators, 1);
  const p = prop(a.kernel);
  const v = a.kernel.createVote(p, "prevote", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, p));
  assert.equal(a.kernel.verifyVote(v), true);
  assert.equal(b.verifyVote(v), false);
  assert.equal(b.verifyVote({ ...v, epoch: 1 }), false, "epoch is signed");
  assert.throws(() => b.createVote(p, "prevote", "v1", a.keys[1]!.privateKey, sign(a.kernel, a.keys, p)), /BFT_PROPOSAL_(INVALID|SIGNATURE_INVALID)/);
});

test("item 2: a vote under another validator-set configuration does not verify", () => {
  const a = fx();
  const other = new BftConsensusKernel(a.domain, [...a.validators, { id: "v4", publicKeyHex: generateEd25519KeyPair().publicKeyHex }], 1);
  assert.notEqual(other.validatorSetHash, a.kernel.validatorSetHash);
  const p = prop(a.kernel);
  const v = a.kernel.createVote(p, "prevote", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, p));
  assert.equal(other.verifyVote(v), false);
  assert.equal(a.kernel.verifyVote({ ...v, validatorSetHash: other.validatorSetHash }), false);
});

test("item 2: contradictory proposals with the same block but another parent root are equivocation", () => {
  const a = fx();
  const p1 = prop(a.kernel);
  const p2 = prop(a.kernel, { parentRoot: hex("1") });
  a.kernel.createVote(p1, "prevote", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, p1));
  assert.throws(() => a.kernel.createVote(p2, "prevote", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, p2)), /BFT_EQUIVOCATION/);
});

test("item 2: votes for two proposal cores never add up to one certificate", () => {
  const a = fx();
  const p1 = prop(a.kernel);
  const p2 = prop(a.kernel, { parentRoot: hex("2") });
  const k2 = new BftConsensusKernel(a.domain, a.validators, 1); // a second (honest-looking) signer state
  const votes = [
    a.kernel.createVote(p1, "prevote", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, p1)),
    a.kernel.createVote(p1, "prevote", "v1", a.keys[1]!.privateKey, sign(a.kernel, a.keys, p1)),
    k2.createVote(p2, "prevote", "v2", a.keys[2]!.privateKey, sign(a.kernel, a.keys, p2)),
  ];
  assert.throws(() => a.kernel.voteCertificate(1, 0, "prevote", p1.blockId, votes), /BFT_QUORUM_NOT_MET/);
  const cert = a.kernel.voteCertificate(1, 0, "prevote", p1.blockId, [...votes,
    k2.createVote(p1, "prevote", "v3", a.keys[3]!.privateKey, sign(a.kernel, a.keys, p1))]);
  assert.equal(cert.proposalHash, a.kernel.proposalHash(p1));
  assert.equal(cert.votes.length, 3);
  assert.equal(a.kernel.verifyCertificate({ ...cert, proposalHash: a.kernel.proposalHash(p2) }), false);
});

test("item 2: after a restart from the durable store, a contradictory proposal at the same position is still refused", () => {
  const a = fx();
  const dir = mkdtempSync(join(tmpdir(), "uep-bft-bind-"));
  try {
    const path = join(dir, "bft.json");
    const k1 = createDurableBftConsensusKernel(a.domain, a.validators, 1, path, {}, { init: "genesis" });
    const p1 = prop(k1);
    k1.createVote(p1, "prevote", "v0", a.keys[0]!.privateKey, sign(k1, a.keys, p1));
    const k2 = createDurableBftConsensusKernel(a.domain, a.validators, 1, path);
    const p2 = prop(k2, { parentRoot: hex("3") });
    assert.throws(() => k2.createVote(p2, "prevote", "v0", a.keys[0]!.privateKey, sign(k2, a.keys, p2)), /BFT_EQUIVOCATION/);
    // The same proposal is re-signable after restart (idempotent).
    assert.equal(k2.verifyVote(k2.createVote(p1, "prevote", "v0", a.keys[0]!.privateKey, sign(k2, a.keys, p1))), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("item 2: a precommit needs a prevote certificate for the same proposal core, not just the same block", () => {
  const a = fx();
  const p1 = prop(a.kernel);
  const p2 = prop(a.kernel, { parentRoot: hex("4") });
  const helpers = [0, 1, 2, 3].map(() => new BftConsensusKernel(a.domain, a.validators, 1));
  const cert2 = a.kernel.voteCertificate(1, 0, "prevote", p2.blockId,
    [0, 1, 2].map(i => helpers[i]!.createVote(p2, "prevote", `v${i}`, a.keys[i]!.privateKey, sign(a.kernel, a.keys, p2))));
  a.kernel.observePrevoteCertificate(cert2);
  const mixed = { ...p1, prevoteCertificate: cert2 };
  assert.throws(() => a.kernel.createVote(mixed, "precommit", "v0", a.keys[0]!.privateKey, sign(a.kernel, a.keys, mixed)), /BFT_(PRECOMMIT_REQUIRES_PREVOTE_QUORUM|PREVOTE_CERTIFICATE_INVALID)/);
});
