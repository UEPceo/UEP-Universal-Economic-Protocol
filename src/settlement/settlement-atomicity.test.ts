/**
 * v0.5.3 regression (settlement atomicity): a port failure in the middle of
 * execute() must leave escrow, accounts, treasury fee allocation, paymaster
 * and receipts exactly as before, and the same settlement must be retryable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MarketplaceTreasury } from "../marketplace/economy.ts";
import { SettlementEngine } from "./engine.ts";
import type { PayoutInstruction, SettlementLedgerPort, SettlementStep } from "./types.ts";

const EUR = "uep-test/teur";

type State = { escrow: bigint; accounts: Map<string, bigint>; fees: bigint; gas: bigint };

function port(s: State, failOn?: (step: SettlementStep) => boolean): SettlementLedgerPort {
  const apply = (step: SettlementStep, sign: 1n | -1n) => {
    if (step.kind === "closeEscrow") s.escrow -= sign * step.amount;
    else if (step.kind === "credit") s.accounts.set(step.accountId, (s.accounts.get(step.accountId) ?? 0n) + sign * step.amount);
    else if (step.kind === "recordFee") s.fees += sign * step.amount;
    else s.gas += sign * step.amount;
  };
  return {
    escrowBalance: () => s.escrow,
    closeEscrow: (_i, amount) => {
      const step: SettlementStep = { kind: "closeEscrow", asset: EUR, amount };
      if (failOn?.(step)) throw new Error("INJECTED_CLOSE_FAILURE");
      apply(step, 1n);
    },
    credit: (accountId, asset, amount) => {
      const step: SettlementStep = { kind: "credit", accountId, asset, amount };
      if (failOn?.(step)) throw new Error("INJECTED_CREDIT_FAILURE");
      apply(step, 1n);
    },
    recordFee: (asset, amount) => {
      const step: SettlementStep = { kind: "recordFee", asset, amount };
      if (failOn?.(step)) throw new Error("INJECTED_FEE_FAILURE");
      apply(step, 1n);
    },
    recordGas: (asset, amount) => apply({ kind: "recordGas", asset, amount }, 1n),
    undo: (step) => apply(step, -1n),
  };
}

function total(s: State): bigint {
  let t = s.escrow + s.fees + s.gas;
  for (const v of s.accounts.values()) t += v;
  return t;
}

const release = (id: string, amount = 1_000n): PayoutInstruction => ({
  settlementId: id, asset: EUR, payerId: "buyer", payeeId: "provider",
  escrowAmount: amount, grossAmount: amount, providerAmount: amount, outcome: "RELEASE",
});

function setup() {
  const treasury = new MarketplaceTreasury({ height: () => 10 });
  return { treasury, engine: new SettlementEngine({ treasury, height: () => 10 }) };
}

test("credit() failing after the fee is reserved rolls back everything and the settle is retryable", () => {
  const { treasury, engine } = setup();
  const s: State = { escrow: 1_000n, accounts: new Map(), fees: 0n, gas: 0n };
  const before = total(s);
  let fail = true;
  const p = port(s, (step) => fail && step.kind === "credit" && step.accountId === "provider");
  assert.throws(() => engine.execute(release("ord-atomic"), p), /INJECTED_CREDIT_FAILURE/);
  // Value conserved and nothing half-applied.
  assert.equal(total(s), before);
  assert.equal(s.escrow, 1_000n);
  assert.equal(s.accounts.get("provider") ?? 0n, 0n);
  assert.equal(s.fees, 0n);
  assert.equal(treasury.hasSettled("ord-atomic"), false);
  assert.equal(treasury.totalOf(EUR), 0n);
  assert.equal(engine.hasExecuted("ord-atomic"), false);
  // Retry succeeds (no FEE_ALREADY_SETTLED).
  fail = false;
  const r = engine.execute(release("ord-atomic"), p);
  assert.equal(s.escrow, 0n);
  assert.equal(s.accounts.get("provider"), r.providerNet);
  assert.equal(s.fees, r.marketplaceFee);
  assert.equal(treasury.totalOf(EUR), r.marketplaceFee);
  assert.equal(total(s), before);
});

test("refund credit failing on a SPLIT rolls back the provider credit already applied", () => {
  const { treasury, engine } = setup();
  const s: State = { escrow: 1_000n, accounts: new Map(), fees: 0n, gas: 0n };
  const split: PayoutInstruction = { ...release("ord-split"), providerAmount: 400n, outcome: "SPLIT" };
  let fail = true;
  const p = port(s, (step) => fail && step.kind === "credit" && step.accountId === "buyer");
  assert.throws(() => engine.execute(split, p), /INJECTED_CREDIT_FAILURE/);
  assert.equal(s.escrow, 1_000n);
  assert.equal(s.accounts.get("provider") ?? 0n, 0n);
  assert.equal(treasury.hasSettled("ord-split"), false);
  fail = false;
  const r = engine.execute(split, p);
  assert.equal(r.providerNet + r.marketplaceFee + r.buyerRefund, 1_000n);
  assert.equal(total(s), 1_000n);
});

test("recordFee() failing is rolled back too; a failing closeEscrow moves nothing", () => {
  const { treasury, engine } = setup();
  const s: State = { escrow: 1_000n, accounts: new Map(), fees: 0n, gas: 0n };
  assert.throws(() => engine.execute(release("ord-f"), port(s, (st) => st.kind === "recordFee")), /INJECTED_FEE_FAILURE/);
  assert.equal(s.escrow, 1_000n);
  assert.equal(total(s), 1_000n);
  assert.equal(treasury.hasSettled("ord-f"), false);
  assert.throws(() => engine.execute(release("ord-f"), port(s, (st) => st.kind === "closeEscrow")), /INJECTED_CLOSE_FAILURE/);
  assert.equal(s.escrow, 1_000n);
  assert.equal(treasury.hasSettled("ord-f"), false);
  engine.execute(release("ord-f"), port(s));
  assert.equal(s.escrow, 0n);
});

test("a port whose undo also fails halts the engine (fail closed)", () => {
  const { engine } = setup();
  const s: State = { escrow: 1_000n, accounts: new Map(), fees: 0n, gas: 0n };
  const p = port(s, (st) => st.kind === "credit");
  p.undo = () => { throw new Error("UNDO_BROKEN"); };
  assert.throws(() => engine.execute(release("ord-h"), p), /SETTLEMENT_ROLLBACK_FAILED/);
  assert.throws(() => engine.execute(release("ord-h2"), port({ escrow: 1_000n, accounts: new Map(), fees: 0n, gas: 0n })), /SETTLEMENT_ENGINE_HALTED/);
});
