import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeAgentAction,
  createAgentKeypair,
  issueCapability,
  revokeCapability,
  agentAttemptsPermissionChange,
  debitBudget,
} from "./agent-identity.ts";
import { AgentNonceStore } from "./agent-nonce.ts";
import { AgentEconomySim, runAgentExperiment } from "./agent-simulation.ts";

describe("UEP-Agent Foundation security", () => {
  it("spend within limit → PASS", () => {
    const kp = createAgentKeypair("a1");
    const cap = issueCapability({
      agentId: "a1",
      publicKeyHex: kp.publicKeyHex,
      ownerId: "owner",
      permissions: ["pay"],
      spendingLimit: 100n,
      allowedAssets: ["UEP-UNIT"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    assert.equal(
      authorizeAgentAction(cap, {
        permission: "pay",
        amount: 50n,
        asset: "UEP-UNIT",
      }).ok,
      true,
    );
  });

  it("spend above limit → REJECT", () => {
    const kp = createAgentKeypair("a2");
    const cap = issueCapability({
      agentId: "a2",
      publicKeyHex: kp.publicKeyHex,
      ownerId: "owner",
      permissions: ["pay"],
      spendingLimit: 10n,
      allowedAssets: ["*"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    const r = authorizeAgentAction(cap, { permission: "pay", amount: 11n });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "SPENDING_LIMIT_EXCEEDED");
  });

  it("unauthorized service → REJECT", () => {
    const kp = createAgentKeypair("a3");
    const cap = issueCapability({
      agentId: "a3",
      publicKeyHex: kp.publicKeyHex,
      ownerId: "owner",
      permissions: ["contract_service", "pay"],
      spendingLimit: 100n,
      allowedAssets: ["*"],
      allowedServices: ["svc-a"],
      ttlMs: 60_000,
    });
    const r = authorizeAgentAction(cap, {
      permission: "contract_service",
      serviceId: "svc-b",
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "SERVICE_NOT_ALLOWED");
  });

  it("revoked agent → REJECT", () => {
    const kp = createAgentKeypair("a4");
    let cap = issueCapability({
      agentId: "a4",
      publicKeyHex: kp.publicKeyHex,
      ownerId: "owner",
      permissions: ["pay"],
      spendingLimit: 100n,
      allowedAssets: ["*"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    cap = revokeCapability(cap);
    const r = authorizeAgentAction(cap, { permission: "pay", amount: 1n });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "AGENT_REVOKED");
  });

  it("nonce reuse → REJECT", () => {
    const store = new AgentNonceStore();
    assert.equal(store.checkAndConsume("a5", "nonce-abc-12345").ok, true);
    const r = store.checkAndConsume("a5", "nonce-abc-12345");
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "NONCE_REPLAY");
  });

  it("agent cannot modify permissions → REJECT", () => {
    const r = agentAttemptsPermissionChange();
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "AGENT_CANNOT_MODIFY_PERMISSIONS");
  });

  it("budget debit reduces remaining", () => {
    const kp = createAgentKeypair("a6");
    let cap = issueCapability({
      agentId: "a6",
      publicKeyHex: kp.publicKeyHex,
      ownerId: "o",
      permissions: ["pay"],
      spendingLimit: 100n,
      allowedAssets: ["*"],
      allowedServices: ["*"],
      ttlMs: 60_000,
    });
    cap = debitBudget(cap, 40n);
    assert.equal(cap.remainingBudget, 60n);
    const r = authorizeAgentAction(cap, { permission: "pay", amount: 61n });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, "BUDGET_EXCEEDED");
  });
});

describe("UEP-Agent economic simulation", () => {
  it("happy path contract + settle", () => {
    const sim = new AgentEconomySim();
    sim.registerService({
      serviceId: "s1",
      name: "S1",
      price: 10n,
      asset: "UEP-UNIT",
      quality: 0.9,
    });
    sim.createOwnerWallet("owner", "UEP-UNIT", 1000n);
    sim.spawnAgent({
      agentId: "agent-h",
      ownerId: "owner",
      spendingLimit: 50n,
      allowedServices: ["s1"],
      allowedAssets: ["UEP-UNIT"],
    });
    const rec = sim.agentRun("agent-h", "nonce-happy-path-001");
    assert.equal(rec.settled, true, rec.error);
    assert.equal(rec.amount, 10n);
    assert.equal(sim.wallets.get("owner")!.balances.get("UEP-UNIT"), 990n);
  });

  it("experiment 20 agents produces stats", () => {
    const { stats, contracts } = runAgentExperiment(20);
    assert.ok(stats.contracts >= 1);
    assert.ok(stats.abuseAttempts >= 1);
    assert.ok(stats.rejected >= 1);
    assert.ok(contracts.length >= 1);
  });
});
