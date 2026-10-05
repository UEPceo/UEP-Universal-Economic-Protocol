/**
 * v0.5.1: a LabNode's domain is bound to what it accepts. The domain is
 * validated at construction, an operator key must be pinned for it, and in ZK
 * mode the proof's domain_id (public input 12) must equal it, so a proof made
 * for another domain is rejected even when the envelope is correctly signed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createNodeIdentity, LabNode } from "./node-protocol.ts";
import { assertEnvelopeMatchesPublicInputs } from "./envelope-public-bind.ts";
import { VerifyingKeyRegistry } from "./verifying-key-registry.ts";
import { isVkPinnedForDomain, pinnedVk } from "./zk-vk-pins.ts";
import { runUepZk } from "./uep-zk-runner.ts";

const other = JSON.parse(
  readFileSync(new URL("./fixtures/vk-pin-other-key.json", import.meta.url), "utf8"),
) as { publicInputsHex: string[]; vkHex: string; proofHex: string };

const kv = (s: string, k: string) => new RegExp(`^${k}=(\\S+)`, "m").exec(s)?.[1];

/** Honest d=4 proof for `domain_id` (the prover accepts any domain). */
function proveForDomain(domainId: number): { proofHex: string; pubs: string[] } {
  const req = {
    depth: 4, seed: 9, sender_secret: "11", sender_salt: "12", recipient_id: "15", treasury_id: "14",
    asset_id: "7", amount: "5000", fee: "5", domain_id: domainId, sender_old_balance: "100000",
    note_blinding: "21", recipient_blinding: "22", treasury_blinding: "23",
  };
  const r = runUepZk(["prove-spend-json"], { stdin: JSON.stringify(req), timeoutMs: 300_000 });
  assert.equal(r.ok, true, r.stderr);
  const proofHex = kv(r.stdout, "proof_hex")!;
  const pubs = Array.from({ length: 13 }, (_, i) => kv(r.stdout, `public_${i}`)!.replace(/^0x/i, ""));
  return { proofHex, pubs };
}

function replayTo(domainId: number, p: { proofHex: string; pubs: string[] }, opts: ConstructorParameters<typeof LabNode>[5] = {}) {
  const seq = createNodeIdentity("seq");
  const mk = () => {
    const n = new LabNode(seq, "uep-lab", domainId, seq.publicKeyHex, seq.nodeId, { requireZkVerify: true, ...opts });
    n.stateRoot = p.pubs[0]!;
    n.nullifierRoot = p.pubs[2]!;
    return n;
  };
  const env = mk().propose({
    previousStateRoot: p.pubs[0]!, newStateRoot: p.pubs[1]!, previousNullifierRoot: p.pubs[2]!, newNullifierRoot: p.pubs[3]!,
    transitionId: `t-${domainId}`, nullifier: p.pubs[10]!, transactionCommitment: p.pubs[11]!, proofHex: p.proofHex, publicInputsHex: p.pubs,
    ...(opts.vkRegistry ? { vkId: "dev-d4" } : {}),
  });
  return mk().apply(env);
}

describe("LabNode domain binding", () => {
  it("the domain must be a non-negative safe integer", () => {
    const id = createNodeIdentity("seq");
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53, "1" as unknown as number]) {
      assert.throws(() => new LabNode(id, "local", bad, id.publicKeyHex, id.nodeId), /DOMAIN_ID_INVALID/);
    }
    assert.doesNotThrow(() => new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId));
  });

  it("an operator-configured key must be pinned for the node's domain", () => {
    const id = createNodeIdentity("seq");
    assert.throws(() => new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId, { defaultVkHex: other.vkHex }), /VK_NOT_PINNED_FOR_DOMAIN/);
    const dev = pinnedVk(4, 1n).vkHex;
    assert.equal(isVkPinnedForDomain(dev, 1), true);
    assert.equal(isVkPinnedForDomain(dev, 2), false);
    assert.throws(() => new LabNode(id, "local", 2, id.publicKeyHex, id.nodeId, { defaultVkHex: dev }), /VK_NOT_PINNED_FOR_DOMAIN/);
    assert.doesNotThrow(() => new LabNode(id, "local", 1, id.publicKeyHex, id.nodeId, { defaultVkHex: dev }));
  });

  it("the envelope domain must equal the proof's domain_id (pure binding check)", () => {
    const pubs = other.publicInputsHex.map((h) => h.replace(/^0x/i, ""));
    const env = {
      protocolVersion: 2, networkId: "local", domainId: Number(BigInt("0x" + pubs[12]!)), nodeId: "seq", sequence: 1,
      previousStateRoot: pubs[0]!, newStateRoot: pubs[1]!, previousNullifierRoot: pubs[2]!, newNullifierRoot: pubs[3]!,
      transitionId: "t", nullifier: pubs[10]!, transactionCommitment: pubs[11]!, publicInputsHex: pubs, ts: 1, signature: "",
    };
    assert.deepEqual(assertEnvelopeMatchesPublicInputs(env), { ok: true });
    assert.deepEqual(assertEnvelopeMatchesPublicInputs({ ...env, domainId: env.domainId + 1 }), { ok: false, error: "ZK_PUBLIC_DOMAIN_MISMATCH" });
  });

  it("an honest proof for domain 2 is rejected by a domain-1 node; a domain-1 proof applies", () => {
    const d2 = proveForDomain(2);
    assert.equal(BigInt("0x" + d2.pubs[12]!), 2n);
    // Default pinned-key profile (the cross-domain replay case).
    assert.deepEqual(replayTo(1, d2), { ok: false, error: "ZK_PUBLIC_DOMAIN_MISMATCH" });
    // Registry profile.
    const reg = new VerifyingKeyRegistry();
    reg.pin({ networkId: "uep-lab", vkId: "dev-d4", vkHex: pinnedVk(4, 1n).vkHex });
    assert.deepEqual(replayTo(1, d2, { vkRegistry: reg, requirePinnedVkId: true }), { ok: false, error: "ZK_PUBLIC_DOMAIN_MISMATCH" });
    // A domain-2 node has no key pinned for domain 2: refused, never verified with the domain-1 key.
    assert.deepEqual(replayTo(2, d2, { vkRegistry: reg, requirePinnedVkId: true }), { ok: false, error: "VK_NOT_PINNED_FOR_DOMAIN" });
    assert.deepEqual(replayTo(2, d2), { ok: false, error: "VK_NOT_PINNED" });

    const d1 = proveForDomain(1);
    assert.deepEqual(replayTo(1, d1), { ok: true });
    assert.deepEqual(replayTo(1, d1, { vkRegistry: reg, requirePinnedVkId: true }), { ok: true });
  });
});
