import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519KeyPair, sha256Hex, stableStringify } from "../core/ed25519.ts";
import { createDurableBftConsensusKernel, legacyAnchorPath } from "./bft-durable-store.ts";
import { openUnifiedValidatorState } from "./unified-node-state.ts";
import { AttestationRegistry, compareWithAttestations, continuityFromEnv, defaultAnchorPath, readAnchor, signStateAttestation, verifyStateAttestation, RETIRED } from "./bft-store-continuity.ts";
import type { BftConsensusKernel, BftProposal } from "./bft-consensus.ts";

const domain = { networkId: "uep-testnet-1", domainId: "EARTH" };
const keys = Array.from({ length: 4 }, () => generateEd25519KeyPair()); // TEST-ONLY, in memory
const validators = keys.map((k, i) => ({ id: `v${i}`, publicKeyHex: k.publicKeyHex }));
const hex = (c: string) => c.repeat(64).slice(0, 64);
const ROOT = new URL("../..", import.meta.url).pathname;

function root(): string { return mkdtempSync(join(tmpdir(), "uep-continuity-")); }
function prevote(k: BftConsensusKernel, block: string, voter = "v1") {
  const p: BftProposal = { ...domain, height: 1, round: 0, proposerId: k.leader(1, 0), parentRoot: hex("0"), blockId: hex(block) };
  const li = validators.findIndex(v => v.id === p.proposerId);
  return k.createVote(p, "prevote", voter, keys[Number(voter.slice(1))]!.privateKey, k.signProposal(p, keys[li]!.privateKey));
}

test("A: unified store: missing store is refused; explicit genesis only without an anchor; retire is one-way", () => {
  const base = root();
  try {
    const dir = join(base, "v1");
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1), /BFT_STORE_MISSING/);
    const u = openUnifiedValidatorState(dir, domain, validators, 1, {}, {}, { init: "genesis" });
    prevote(u.kernel, "a");
    assert.ok(existsSync(defaultAnchorPath(dir)), "anchor outside the state directory");
    // Store deleted, operator tries genesis again: the anchor proves earlier state.
    rmSync(dir, { recursive: true, force: true });
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1), /BFT_STORE_MISSING/);
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1, {}, {}, { init: "genesis" }), /BFT_STORE_MISSING/);
    // Re-key/rejoin: the identity starts watch-only and never signs again, even after a restart without flags.
    const r = openUnifiedValidatorState(dir, domain, validators, 1, {}, {}, { rejoin: "retire" });
    assert.equal(r.kernel.signingSuspended, RETIRED);
    assert.throws(() => prevote(r.kernel, "b"), /BFT_IDENTITY_RETIRED/);
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1), /BFT_STORE_STALE: identity retired/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("B: unified store: an older valid copy is refused (BFT_STORE_STALE); intact restart keeps anti-equivocation", () => {
  const base = root();
  try {
    const dir = join(base, "v1");
    const u = openUnifiedValidatorState(dir, domain, validators, 1, {}, {}, { init: "genesis" });
    const old = join(base, "old"); mkdirSync(old);
    for (const f of ["uep-state.wal", "uep-state.checkpoint"]) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(old, f));
    prevote(u.kernel, "a");
    // Control: intact restart refuses the conflicting vote.
    const again = openUnifiedValidatorState(dir, domain, validators, 1);
    assert.throws(() => prevote(again.kernel, "b"), /BFT_EQUIVOCATION/);
    // Rollback to the older (checksum-valid) copy.
    for (const f of ["uep-state.wal", "uep-state.checkpoint"]) { if (existsSync(join(dir, f))) unlinkSync(join(dir, f)); if (existsSync(join(old, f))) copyFileSync(join(old, f), join(dir, f)); }
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1), /BFT_STORE_STALE/);
    // Same seq, different content (a forked copy) is refused as well.
    const anchor = readAnchor(defaultAnchorPath(dir))!;
    writeFileSync(defaultAnchorPath(dir), JSON.stringify({ ...anchor, seq: 1, hash: hex("f") }));
    assert.throws(() => openUnifiedValidatorState(dir, domain, validators, 1), /BFT_STORE_STALE: store hash differs/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("A+B: legacy store (format 2): missing refused, rollback refused, stateSeq and hash chain advance", () => {
  const base = root();
  try {
    const dir = join(base, "v1"); mkdirSync(dir);
    const path = join(dir, "bft-kernel.json");
    assert.throws(() => createDurableBftConsensusKernel(domain, validators, 1, path), /BFT_STORE_MISSING/);
    const k = createDurableBftConsensusKernel(domain, validators, 1, path, {}, { init: "genesis" });
    const first = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(first.formatVersion, 2); assert.equal(first.stateSeq, 1); assert.equal(first.prevChecksum, "");
    copyFileSync(path, join(base, "old.json"));
    prevote(k, "a");
    const next = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(next.stateSeq > 1); assert.equal(typeof next.prevChecksum, "string");
    assert.equal(readAnchor(legacyAnchorPath(path))!.seq, next.stateSeq);
    copyFileSync(join(base, "old.json"), path);
    assert.throws(() => createDurableBftConsensusKernel(domain, validators, 1, path), /BFT_STORE_STALE/);
    unlinkSync(path);
    assert.throws(() => createDurableBftConsensusKernel(domain, validators, 1, path, {}, { init: "genesis" }), /BFT_STORE_MISSING/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("compat: a format-1 store without seq loads once, is anchored, then moves to format 2", () => {
  const base = root();
  try {
    const dir = join(base, "v1"); mkdirSync(dir);
    const path = join(dir, "bft-kernel.json");
    const vsh = sha256Hex(stableStringify([...validators].map(v => ({ id: v.id, publicKeyHex: v.publicKeyHex })).sort((a, b) => a.id.localeCompare(b.id))));
    const payload = { formatVersion: 1, networkId: domain.networkId, domainId: domain.domainId, validatorSetHash: vsh, state: { version: 3, votes: [], committed: [], locks: [], roundChanges: [] } };
    writeFileSync(path, JSON.stringify({ ...payload, checksum: sha256Hex(stableStringify(payload)) }));
    const k = createDurableBftConsensusKernel(domain, validators, 1, path);
    assert.equal(readAnchor(legacyAnchorPath(path))!.seq, 0);
    prevote(k, "a");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).formatVersion, 2);
    const k2 = createDurableBftConsensusKernel(domain, validators, 1, path);
    assert.throws(() => prevote(k2, "b"), /BFT_EQUIVOCATION/);
    // Unified migration of a pre-0.5.84 directory (legacy files, no anchor) is accepted and anchored.
    const dir2 = join(base, "v2"); mkdirSync(dir2);
    writeFileSync(join(dir2, "bft-kernel.json"), JSON.stringify({ ...payload, checksum: sha256Hex(stableStringify(payload)) }));
    const u = openUnifiedValidatorState(dir2, domain, validators, 1);
    assert.equal(u.migration.migrated, true);
    assert.equal(readAnchor(defaultAnchorPath(dir2))!.seq, u.store.frameSeq);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("C: state attestations: signature, context and freshness comparison; registry keeps the highest", () => {
  const base = root();
  try {
    const body = { v: 1 as const, ...domain, validatorId: "v1", stateSeq: 7, stateHash: hex("7") };
    const a = signStateAttestation(body, keys[1]!.privateKey);
    assert.equal(verifyStateAttestation(a, validators[1]!.publicKeyHex, domain), true);
    assert.equal(verifyStateAttestation({ ...a, stateSeq: 8 }, validators[1]!.publicKeyHex, domain), false, "tampered");
    assert.equal(verifyStateAttestation(a, validators[2]!.publicKeyHex, domain), false, "other key");
    assert.equal(verifyStateAttestation(a, validators[1]!.publicKeyHex, { ...domain, domainId: "MARS" }), false, "other domain");
    assert.deepEqual(compareWithAttestations({ seq: 7, hash: hex("7") }, [a]), { stale: false, maxSeen: 7 });
    assert.equal(compareWithAttestations({ seq: 3, hash: hex("3") }, [a]).stale, true);
    assert.equal(compareWithAttestations({ seq: 7, hash: hex("8") }, [a]).stale, true, "same seq, other hash");
    const reg = new AttestationRegistry(join(base, "reg.json"));
    assert.equal(reg.offer(a), true);
    assert.equal(reg.offer(signStateAttestation({ ...body, stateSeq: 5 }, keys[1]!.privateKey)), false);
    assert.equal(new AttestationRegistry(join(base, "reg.json")).get("v1")!.stateSeq, 7, "persisted");
    assert.throws(() => continuityFromEnv({ UEP_BFT_STORE_INIT: "yes" }), /BFT_STORE_INIT_INVALID/);
    assert.deepEqual(continuityFromEnv({ UEP_BFT_REJOIN: "retire" }), { rejoin: "retire" });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// EXP-104: kill -9 between fsync and rename never leaves a released signature without a durable record.
for (const [backend, point] of [["legacy", "fsynced-before-rename"], ["unified", "checkpoint-fsynced"]] as const) {
  test(`EXP-104 (${backend}): SIGKILL at ${point} releases no signature without a durable record`, () => {
    const base = root();
    try {
      const stateDir = join(base, "v"); mkdirSync(stateDir);
      const keysFile = join(base, "keys.json");
      writeFileSync(keysFile, JSON.stringify({ domain, validators, pems: keys.map(k => k.privateKey.export({ type: "pkcs8", format: "pem" }).toString()) }), { mode: 0o600 });
      const run = (pt: string, start: string, block: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/node/bft-store-continuity-signer.fixture.ts", backend, stateDir, keysFile, pt, start, block], { cwd: ROOT, encoding: "utf8" });
      const crashed = run(point, "genesis", "a");
      assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
      assert.ok(!/SIGNED/.test(crashed.stdout), "no signature left the process");
      // Restart: either the vote record is durable (then a conflicting vote is refused), or it is not
      // (then no signature for it exists anywhere and voting again is safe). Unified: the vote frame is
      // fsynced before the checkpoint, so it must be durable.
      const after = run("none", "restart", "b");
      assert.equal(after.status, 0, after.stderr);
      if (backend === "unified") assert.match(after.stdout, /REFUSED BFT_EQUIVOCATION/);
      else assert.match(after.stdout, /SIGNED |REFUSED BFT_EQUIVOCATION/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}
