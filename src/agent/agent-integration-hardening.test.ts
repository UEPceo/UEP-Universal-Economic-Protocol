import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentKeypair, issueCapability } from "./agent-identity.ts";
import {
  createOwnerKeypair,
  issueSignedCapability,
  verifySignedCapability,
  detectForgedOwnerLabel,
} from "./agent-capability-cert.ts";
import {
  signActionRequest,
  authorizeSignedAction,
  verifyActionRequest,
} from "./agent-action-request.ts";
import { AgentNonceStore } from "./agent-nonce.ts";
import { AgentEconomySim } from "./agent-simulation.ts";

describe("UEP-Agent hardening", () => {
  it("owner-signed capability verifies; forged ownerId fails", () => {
    const owner = createOwnerKeypair("alice");
    const agent = createAgentKeypair("bot-1");
    const signed = issueSignedCapability({
      owner,
      agentId: agent.agentId,
      agentPublicKeyHex: agent.publicKeyHex,
      permissions: ["pay"],
      spendingLimit: 100n,
      allowedAssets: ["*"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    assert.equal(verifySignedCapability(signed).ok, true);

    const trusted = new Map([["alice", owner.publicKeyHex]]);
    assert.equal(detectForgedOwnerLabel(signed, trusted).ok, true);

    // Attacker forges label ownerId=alice but signs with own key
    const attacker = createOwnerKeypair("attacker");
    const forged = issueSignedCapability({
      owner: attacker,
      agentId: agent.agentId,
      agentPublicKeyHex: agent.publicKeyHex,
      permissions: ["pay"],
      spendingLimit: 1_000_000n,
      allowedAssets: ["*"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    // Mutate ownerId label to victim
    forged.capability.ownerId = "alice";
    // signature no longer matches body → invalid
    assert.equal(verifySignedCapability(forged).ok, false);
    assert.equal(detectForgedOwnerLabel(forged, trusted).ok, false);
  });

  it("ActionRequest must be signed before pay authorization", () => {
    const agent = createAgentKeypair("bot-2");
    const cap = issueCapability({
      agentId: agent.agentId,
      publicKeyHex: agent.publicKeyHex,
      ownerId: "o",
      permissions: ["pay"],
      spendingLimit: 50n,
      allowedAssets: ["UEP-UNIT"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    const nonces = new AgentNonceStore();
    const signed = signActionRequest(agent, {
      agentId: agent.agentId,
      permission: "pay",
      amount: 10n,
      asset: "UEP-UNIT",
      nonce: "nonce-act-00123",
      sequence: 1,
      ts: Date.now(),
    });
    assert.equal(verifyActionRequest(agent.publicKeyHex, signed), true);
    const ok = authorizeSignedAction({ signed, capability: cap, nonces });
    assert.equal(ok.ok, true, (ok as { reason?: string }).reason);

    // Tampered amount after sign
    const bad = {
      ...signed,
      request: { ...signed.request, amount: 999n },
    };
    const nonces2 = new AgentNonceStore();
    const r = authorizeSignedAction({
      signed: bad,
      capability: cap,
      nonces: nonces2,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "ACTION_SIG_INVALID");
  });

  it("nonce window prunes; sequence replay rejected", () => {
    const store = new AgentNonceStore({ ttlMs: 50, sequenceWindow: 5 });
    assert.equal(store.checkAndConsume("a", "nonce-aaaa-0001", 1).ok, true);
    assert.equal(store.checkAndConsume("a", "nonce-aaaa-0002", 2).ok, true);
    assert.equal(store.checkAndConsume("a", "nonce-aaaa-0002", 2).ok, false);
    const r = store.checkAndConsume("a", "nonce-aaaa-0003", 1);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "SEQUENCE_REPLAY");
    // After TTL, opaque nonces prune (sequence watermark remains)
    const t0 = Date.now();
    while (Date.now() - t0 < 60) {
      /* wait ttl */
    }
    store.prune("a");
    assert.ok(store.size("a") <= 2);
  });

  it("sim path requires signed pay ActionRequest end-to-end", () => {
    const sim = new AgentEconomySim();
    sim.registerService({
      serviceId: "s1",
      name: "S1",
      price: 10n,
      asset: "UEP-UNIT",
      quality: 0.9,
    });
    sim.createOwnerWallet("owner", "UEP-UNIT", 500n);
    sim.spawnAgent({
      agentId: "agent-sig",
      ownerId: "owner",
      spendingLimit: 100n,
      allowedServices: ["s1"],
      allowedAssets: ["UEP-UNIT"],
    });
    const sc = sim.signedCapabilities.get("agent-sig");
    assert.ok(sc);
    assert.equal(verifySignedCapability(sc!).ok, true);
    const rec = sim.agentRun("agent-sig", "nonce-e2e-signed-01");
    assert.equal(rec.settled, true, rec.error);
  });
});
