import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftProposal } from "./bft-consensus.ts";

const domain = { networkId: "uep-testnet-1", domainId: "EARTH" };
function fixture(n = 4, f = 1) {
  const keys = Array.from({ length: n }, () => generateEd25519KeyPair());
  const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
  return { keys, validators, kernel: new BftConsensusKernel(domain, validators, f) };
}
const hex = (n: string) => n.repeat(64).slice(0, 64);
function proposal(kernel: BftConsensusKernel, blockId = hex("a"), height = 1, round = 0): BftProposal {
  return { ...domain, height, round, proposerId: kernel.leader(height, round), parentRoot: hex("0"), blockId };
}

function vote(kernel: BftConsensusKernel, keys: ReturnType<typeof fixture>["keys"], p: BftProposal, phase: "prevote" | "precommit", voterId: string) {
  const proposerIndex = kernel.validators.findIndex(v => v.id === p.proposerId);
  const proposerKey = keys[proposerIndex]!;
  const voterIndex = Number(voterId.slice(1));
  return kernel.createVote(p, phase, voterId, keys[voterIndex]!.privateKey,
    kernel.signProposal(p, proposerKey.privateKey));
}

test("requires n >= 3f+1 and derives quorum 2f+1", () => {
  assert.throws(() => fixture(3, 1), /BFT_VALIDATOR_SET_TOO_SMALL/);
  assert.equal(fixture().kernel.quorum, 3);
});
test("leader rotation is deterministic and proposal signature binds complete proposal", () => {
  const { kernel, keys, validators } = fixture();
  const p = proposal(kernel);
  const leaderIndex = validators.findIndex(v => v.id === p.proposerId);
  const signature = kernel.signProposal(p, keys[leaderIndex]!.privateKey);
  assert.equal(kernel.verifyProposal(p, signature), true);
  assert.equal(kernel.verifyProposal({ ...p, parentRoot: hex("1") }, signature), false);
  assert.notEqual(kernel.leader(1, 0), kernel.leader(1, 1));
});
test("three unique precommit signatures form a certificate; duplicate voter does not count twice", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel);
  const prevotes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const prevoteCertificate = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
  kernel.observePrevoteCertificate(prevoteCertificate);
  const commitProposal = { ...p, prevoteCertificate };
  const votes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, commitProposal, "precommit", `v${i}`));
  assert.equal(kernel.verifyCertificate(kernel.certificate(1, 0, p.blockId, votes)), true);
  assert.throws(() => kernel.certificate(1, 0, p.blockId, [votes[0]!, votes[0]!, votes[1]!]), /BFT_QUORUM_NOT_MET/);
});
test("votes bind domain, height, round, phase, validator and block", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel);
  const signedVote = vote(kernel, keys, p, "prevote", "v0");
  assert.equal(kernel.verifyVote(signedVote), true);
  assert.equal(kernel.verifyVote({ ...signedVote, round: 1 }), false);
  assert.equal(kernel.verifyVote({ ...signedVote, domainId: "MARS" }), false);
  assert.equal(kernel.verifyVote({ ...signedVote, blockId: hex("b") }), false);
});
test("one validator cannot sign two blocks in the same height/round/phase", () => {
  const { kernel, keys } = fixture();
  vote(kernel, keys, proposal(kernel), "prevote", "v0");
  assert.throws(() => vote(kernel, keys, proposal(kernel, hex("b")), "prevote", "v0"), /BFT_EQUIVOCATION/);
});
test("commit is idempotent for one block and refuses a conflicting block at same height", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel);
  const prevotes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const prevoteCertificate = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
  kernel.observePrevoteCertificate(prevoteCertificate);
  const commitProposal = { ...p, prevoteCertificate };
  const votes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, commitProposal, "precommit", `v${i}`));
  const cert = kernel.certificate(1, 0, p.blockId, votes);
  kernel.recordCommit(cert); kernel.recordCommit(cert);
  const otherKernel = new BftConsensusKernel(domain, kernel.validators.map(v => ({ ...v })), 1);
  const other = proposal(otherKernel, hex("b"));
  const otherPrevotes = keys.slice(0, 3).map((k, i) => vote(otherKernel, keys, other, "prevote", `v${i}`));
  const otherPrevoteCert = otherKernel.voteCertificate(1, 0, "prevote", other.blockId, otherPrevotes);
  otherKernel.observePrevoteCertificate(otherPrevoteCert);
  const otherCommitProposal = { ...other, prevoteCertificate: otherPrevoteCert };
  const otherVotes = keys.slice(0, 3).map((k, i) => vote(otherKernel, keys, otherCommitProposal, "precommit", `v${i}`));
  assert.throws(() => kernel.recordCommit(otherKernel.certificate(1, 0, other.blockId, otherVotes)), /BFT_CONFLICTING_COMMIT/);
});
test("export/import preserves anti-equivocation and committed height", () => {
  const { kernel, keys, validators } = fixture();
  const p = proposal(kernel);
  vote(kernel, keys, p, "prevote", "v0");
  const next = new BftConsensusKernel(domain, validators, 1);
  next.loadState(kernel.exportState());
  assert.throws(() => vote(next, keys, proposal(next, hex("b")), "prevote", "v0"), /BFT_EQUIVOCATION/);
});


test("a lock blocks conflicting prevotes without a higher valid-round certificate", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const votes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, votes);
  kernel.observePrevoteCertificate(cert);
  const changes = keys.slice(0, 3).map((k, i) => kernel.createRoundChange(1, 1, `v${i}`, k.privateKey));
  const rc = kernel.roundChangeCertificate(1, 1, changes);
  assert.throws(() => vote(kernel, keys, { ...proposal(kernel, hex("b"), 1, 1), roundChangeCertificate: rc }, "prevote", "v0"), /BFT_PROPOSAL_IGNORES_HIGHEST_LOCK/);
  const safe = { ...proposal(kernel, p.blockId, 1, 1), validRound: 0, validRoundCertificate: cert, roundChangeCertificate: rc };
  assert.doesNotThrow(() => vote(kernel, keys, safe, "prevote", "v0"));
});

test("round-change quorum carries forward the highest certified lock", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const votes = keys.slice(0, 3).map((k, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const prevoteCert = kernel.voteCertificate(1, 0, "prevote", p.blockId, votes);
  kernel.observePrevoteCertificate(prevoteCert);
  const changes = keys.slice(0, 3).map((k, i) => kernel.createRoundChange(1, 1, `v${i}`, k.privateKey));
  const rc = kernel.roundChangeCertificate(1, 1, changes);
  assert.deepEqual(kernel.requiredProposalFromRoundChanges(rc), { blockId: p.blockId, validRound: 0, validRoundCertificate: prevoteCert });
});

test("round-change rejects duplicate identities and invalid lock proofs", () => {
  const { kernel, keys } = fixture();
  const changes = keys.slice(0, 2).map((k, i) => kernel.createRoundChange(1, 1, `v${i}`, k.privateKey));
  assert.throws(() => kernel.roundChangeCertificate(1, 1, [...changes, changes[0]!]), /BFT_ROUND_CHANGE_QUORUM_NOT_MET/);
  assert.equal(kernel.verifyRoundChange({ ...changes[0]!, lockedRound: 0, lockedBlockId: hex("a") }), false);
});


test("state export/import preserves a lock and prevents downgrade", () => {
  const { kernel, keys, validators } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const votes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, votes);
  kernel.observePrevoteCertificate(cert);
  // Re-observing the same block from an older round must never reduce lock height/round.
  kernel.observePrevoteCertificate(cert);
  const restored = new BftConsensusKernel(domain, validators, 1);
  restored.loadState(kernel.exportState());
  assert.equal(restored.getLock(1)?.round, 0);
  assert.equal(restored.getLock(1)?.blockId, p.blockId);
  assert.throws(() => restored.createRoundChange(1, 0, "v0", keys[0]!.privateKey), /BFT_ROUND_CHANGE_POSITION_INVALID/);
});

test("a prevote certificate cannot be used directly as commit finality", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel);
  const votes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, votes);
  assert.throws(() => kernel.recordCommit(cert), /BFT_CERTIFICATE_INVALID/);
});


test("a validator refuses to vote when the proposer signature is missing or invalid", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel);
  assert.throws(() => kernel.createVote(p, "prevote", "v0", keys[0]!.privateKey, ""), /BFT_PROPOSAL_SIGNATURE_INVALID/);
  const wrongIndex = (kernel.validators.findIndex(v => v.id === p.proposerId) + 1) % keys.length;
  assert.throws(() => kernel.createVote(p, "prevote", "v0", keys[0]!.privateKey,
    kernel.signProposal(p, keys[wrongIndex]!.privateKey)), /BFT_PROPOSAL_SIGNATURE_INVALID/);
});

test("precommit requires the matching prevote certificate to be registered as the current lock", () => {
  const { kernel, keys } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const prevotes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
  const commitProposal = { ...p, prevoteCertificate: cert };

  assert.throws(() => vote(kernel, keys, commitProposal, "precommit", "v0"), /BFT_PRECOMMIT_REQUIRES_REGISTERED_LOCK/);
  kernel.observePrevoteCertificate(cert);
  assert.doesNotThrow(() => vote(kernel, keys, commitProposal, "precommit", "v0"));
});

test("state restore rejects duplicate lock entries and a lock conflicting with a committed block", () => {
  const { kernel, keys, validators } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const prevotes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
  kernel.observePrevoteCertificate(cert);
  const state = kernel.exportState();
  const restored = new BftConsensusKernel(domain, validators, 1);

  assert.throws(() => restored.loadState({ ...state, locks: [...state.locks, state.locks[0]!] }), /BFT_STATE_INVALID/);
  assert.throws(() => restored.loadState({ ...state, committed: [["1", hex("b")]] }), /BFT_STATE_LOCK_CONFLICTS_WITH_COMMIT/);

  // Failed imports must be atomic: they must not partially replace live state.
  assert.equal(restored.getLock(1), null);
  restored.loadState(state);
  assert.equal(restored.getLock(1)?.blockId, p.blockId);
});

test("restore rejects a lock certificate whose block or round metadata is inconsistent", () => {
  const { kernel, keys, validators } = fixture();
  const p = proposal(kernel, hex("a"), 1, 0);
  const prevotes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
  const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
  kernel.observePrevoteCertificate(cert);
  const state = kernel.exportState();
  const badLock = { ...state.locks[0]![1], blockId: hex("b") };
  const restored = new BftConsensusKernel(domain, validators, 1);
  assert.throws(() => restored.loadState({ ...state, locks: [["1", badLock]] }), /BFT_STATE_INVALID_LOCK/);
});

test("durable write-ahead store survives restart and preserves anti-equivocation", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDurableBftConsensusKernel } = await import("./bft-durable-store.ts");
  const { keys, validators } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "uep-bft-store-"));
  const statePath = join(directory, "validator-state.json");
  try {
    const first = createDurableBftConsensusKernel(domain, validators, 1, statePath, {}, { init: "genesis" });
    vote(first, keys, proposal(first), "prevote", "v0");
    const restarted = createDurableBftConsensusKernel(domain, validators, 1, statePath);
    assert.throws(() => vote(restarted, keys, proposal(restarted, hex("b")), "prevote", "v0"), /BFT_EQUIVOCATION/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("durable store persists a certified lock before precommit and restores it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDurableBftConsensusKernel } = await import("./bft-durable-store.ts");
  const { keys, validators } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "uep-bft-lock-"));
  const statePath = join(directory, "validator-state.json");
  try {
    const kernel = createDurableBftConsensusKernel(domain, validators, 1, statePath, {}, { init: "genesis" });
    const p = proposal(kernel);
    const prevotes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
    const cert = kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes);
    kernel.observePrevoteCertificate(cert);
    const restarted = createDurableBftConsensusKernel(domain, validators, 1, statePath);
    assert.equal(restarted.getLock(1)?.blockId, p.blockId);
    assert.doesNotThrow(() => vote(restarted, keys, { ...p, prevoteCertificate: cert }, "precommit", "v0"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a failed durable write prevents vote signing and leaves no in-memory vote reservation", () => {
  const { keys, validators } = fixture();
  const kernel = new BftConsensusKernel(domain, validators, 1, () => { throw new Error("disk failure"); });
  const p = proposal(kernel);
  const proposerIndex = kernel.validators.findIndex(v => v.id === p.proposerId);
  const signature = kernel.signProposal(p, keys[proposerIndex]!.privateKey);
  assert.throws(() => kernel.createVote(p, "prevote", "v0", keys[0]!.privateKey, signature), /disk failure/);
  const healthyKernel = new BftConsensusKernel(domain, validators, 1);
  assert.doesNotThrow(() => vote(healthyKernel, keys, p, "prevote", "v0"));
});

test("durable store rejects corrupted data and validator-set mismatch", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BftDurableStateStore, createDurableBftConsensusKernel } = await import("./bft-durable-store.ts");
  const { keys, validators } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "uep-bft-corrupt-"));
  const statePath = join(directory, "validator-state.json");
  try {
    createDurableBftConsensusKernel(domain, validators, 1, statePath, {}, { init: "genesis" });
    writeFileSync(statePath, "{not-json");
    assert.throws(() => new BftDurableStateStore(statePath, domain, validators).load(), /BFT_STORE_CORRUPT_JSON/);
    writeFileSync(statePath, "{}");
    assert.throws(() => createDurableBftConsensusKernel(domain, validators, 1, statePath), /BFT_STORE_CONTEXT_OR_FORMAT_MISMATCH/);
    const otherValidators = validators.map(v => ({ ...v }));
    otherValidators[0] = { ...otherValidators[0]!, publicKeyHex: keys[1]!.publicKeyHex };
    assert.throws(() => new BftDurableStateStore(statePath, domain, otherValidators).load(), /BFT_STORE_CONTEXT_OR_FORMAT_MISMATCH/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("durable round-change intent prevents signing conflicting lock claims after restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDurableBftConsensusKernel } = await import("./bft-durable-store.ts");
  const { keys, validators } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "uep-bft-round-change-"));
  const statePath = join(directory, "validator-state.json");
  try {
    const kernel = createDurableBftConsensusKernel(domain, validators, 1, statePath, {}, { init: "genesis" });
    kernel.createRoundChange(1, 2, "v0", keys[0]!.privateKey); // no lock included
    const p = proposal(kernel, hex("a"), 1, 0);
    const prevotes = keys.slice(0, 3).map((_, i) => vote(kernel, keys, p, "prevote", `v${i}`));
    kernel.observePrevoteCertificate(kernel.voteCertificate(1, 0, "prevote", p.blockId, prevotes));
    const restarted = createDurableBftConsensusKernel(domain, validators, 1, statePath);
    assert.throws(() => restarted.createRoundChange(1, 2, "v0", keys[0]!.privateKey), /BFT_ROUND_CHANGE_EQUIVOCATION/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
