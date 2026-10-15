/** 0.5.83 Block B (unit): equivocation evidence is self-verifying, canonical and persisted across reopen. */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftProposal } from "./bft-consensus.ts";
import { EquivocationEvidenceStore, makeEquivocationEvidence, verifyEquivocationEvidence } from "./bft-equivocation.ts";

const keys = [0, 1, 2, 3].map(() => generateEd25519KeyPair());
const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
const domain = { networkId: "uep-testnet-1", domainId: "EARTH" };
const kernel = new BftConsensusKernel(domain, validators, 1);
const prop = (blockId: string, round = 0): BftProposal => ({ ...domain, height: 5, round, proposerId: kernel.leader(5, round), parentRoot: "a".repeat(64), blockId });
const signed = (p: BftProposal) => ({ proposal: p, signature: kernel.signProposal(p, keys[Number(p.proposerId.slice(1))]!.privateKey) });

test("evidence verifies only for two different blocks signed by the leader at one (height, round)", () => {
  const a = signed(prop("1".repeat(64))), b = signed(prop("2".repeat(64)));
  const ev = makeEquivocationEvidence(a, b);
  assert.equal(verifyEquivocationEvidence(kernel, ev), true);
  assert.deepEqual(makeEquivocationEvidence(b, a), ev, "canonical order");
  assert.equal(verifyEquivocationEvidence(kernel, makeEquivocationEvidence(a, a)), false, "same block is not evidence");
  assert.equal(verifyEquivocationEvidence(kernel, { ...ev, b: { ...ev.b, signature: ev.a.signature } }), false, "forged signature");
  const p6: BftProposal = { ...prop("3".repeat(64)), height: 6, proposerId: kernel.leader(6, 0) };
  assert.equal(verifyEquivocationEvidence(kernel, makeEquivocationEvidence(a, signed(p6))), false, "different heights / proposers");
  const foreign = new BftConsensusKernel({ ...domain, networkId: "uep-other-1" }, validators, 1);
  assert.equal(verifyEquivocationEvidence(foreign, ev), false, "another network");
});

test("store persists, de-duplicates, drops a torn last line and re-verifies on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "uep-ev-"));
  try {
    const path = join(dir, "ev.jsonl");
    const s = new EquivocationEvidenceStore(path, kernel);
    const ev = makeEquivocationEvidence(signed(prop("1".repeat(64))), signed(prop("2".repeat(64))));
    assert.equal(s.add(ev), true);
    assert.equal(s.add(ev), false);
    appendFileSync(path, "{\"kind\":\"uep-bft-equiv"); // torn tail after a crash
    const re = new EquivocationEvidenceStore(path, kernel);
    assert.equal(re.all().length, 1);
    assert.equal(re.has(ev.proposerId, 5, 0), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
