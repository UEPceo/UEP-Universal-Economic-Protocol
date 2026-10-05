/**
 * Settlement engine tests (v0.5.2): plan / execute, conservation, re-entry,
 * already-executed, receipt hash, batch inclusion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MarketplaceTreasury } from "../marketplace/economy.ts";
import { SettlementEngine, settlementReceiptHash, verifySettlementReceipt } from "./engine.ts";
import { settlementBatch, receiptInclusionProof, verifyReceiptInclusion } from "./batch.ts";
import type { PayoutInstruction, SettlementLedgerPort } from "./types.ts";

const EUR = "uep-test/teur";

function memPort(escrow: { amount: bigint }, accounts: Map<string, bigint>, fees: { n: bigint }, gas: { n: bigint }): SettlementLedgerPort {
  return {
    escrowBalance: () => escrow.amount,
    closeEscrow: (_i, amount) => {
      if (amount > escrow.amount) throw new Error("HELD_BALANCE_INSUFFICIENT");
      escrow.amount -= amount;
    },
    credit: (accountId, _asset, amount) => {
      accounts.set(accountId, (accounts.get(accountId) ?? 0n) + amount);
    },
    recordFee: (_asset, amount) => { fees.n += amount; },
    recordGas: (_asset, amount) => { gas.n += amount; },
  };
}

function engine(height = 10) {
  let h = height;
  const treasury = new MarketplaceTreasury({ height: () => h });
  return {
    engine: new SettlementEngine({ treasury, height: () => h }),
    treasury,
    advance: (n: number) => { h += n; },
  };
}

test("RELEASE: fee on provider amount, conservation, receipt verifies", () => {
  const { engine: e } = engine();
  const escrow = { amount: 1_000n };
  const accounts = new Map<string, bigint>();
  const fees = { n: 0n };
  const gas = { n: 0n };
  const instruction: PayoutInstruction = {
    settlementId: "ord-1",
    asset: EUR,
    payerId: "buyer",
    payeeId: "provider",
    escrowAmount: 1_000n,
    grossAmount: 1_000n,
    providerAmount: 1_000n,
    outcome: "RELEASE",
  };
  const receipt = e.execute(instruction, memPort(escrow, accounts, fees, gas));
  assert.equal(escrow.amount, 0n);
  assert.equal(receipt.marketplaceFee + receipt.providerNet + receipt.buyerRefund + receipt.gasCaptured, 1_000n);
  assert.equal(receipt.buyerRefund, 0n);
  assert.equal(accounts.get("provider"), receipt.providerNet);
  assert.equal(fees.n, receipt.marketplaceFee);
  assert.ok(verifySettlementReceipt(receipt));
  const { receiptHash, ...body } = receipt;
  assert.equal(settlementReceiptHash(body), receiptHash);
  // Re-execute refused.
  assert.throws(() => e.execute(instruction, memPort({ amount: 1_000n }, new Map(), { n: 0n }, { n: 0n })), /SETTLEMENT_ALREADY_EXECUTED/);
});

test("REFUND_BUYER and SPLIT outcomes", () => {
  const { engine: e } = engine();
  const refund: PayoutInstruction = {
    settlementId: "ord-r",
    asset: EUR,
    payerId: "buyer",
    payeeId: "provider",
    escrowAmount: 500n,
    grossAmount: 500n,
    providerAmount: 0n,
    outcome: "REFUND_BUYER",
  };
  const accounts = new Map<string, bigint>();
  const r = e.execute(refund, memPort({ amount: 500n }, accounts, { n: 0n }, { n: 0n }));
  assert.equal(r.marketplaceFee, 0n);
  assert.equal(r.buyerRefund, 500n);
  assert.equal(accounts.get("buyer"), 500n);

  const split: PayoutInstruction = {
    settlementId: "ord-s",
    asset: EUR,
    payerId: "buyer",
    payeeId: "provider",
    escrowAmount: 1_000n,
    grossAmount: 1_000n,
    providerAmount: 400n,
    outcome: "SPLIT",
  };
  const accounts2 = new Map<string, bigint>();
  const fees = { n: 0n };
  const s = e.execute(split, memPort({ amount: 1_000n }, accounts2, fees, { n: 0n }));
  assert.equal(s.providerNet + s.marketplaceFee + s.buyerRefund, 1_000n);
  assert.ok(s.providerNet > 0n && s.buyerRefund > 0n);
});

test("re-entrant execute is refused", () => {
  const { engine: e } = engine();
  const instruction: PayoutInstruction = {
    settlementId: "ord-re",
    asset: EUR,
    payerId: "buyer",
    payeeId: "provider",
    escrowAmount: 100n,
    grossAmount: 100n,
    providerAmount: 100n,
    outcome: "RELEASE",
  };
  let nested = false;
  const port: SettlementLedgerPort = {
    escrowBalance: () => 100n,
    closeEscrow: () => {
      if (!nested) {
        nested = true;
        assert.throws(() => e.execute({ ...instruction, settlementId: "ord-re2" }, port), /SETTLEMENT_REENTRANT/);
      }
    },
    credit: () => {},
    recordFee: () => {},
    recordGas: () => {},
  };
  e.execute(instruction, port);
  assert.equal(nested, true);
});

test("batch root and inclusion proof", () => {
  const { engine: e } = engine();
  const receipts = [];
  for (let i = 0; i < 3; i++) {
    const id = `ord-b${i}`;
    receipts.push(e.execute({
      settlementId: id,
      asset: EUR,
      payerId: "buyer",
      payeeId: "provider",
      escrowAmount: 100n + BigInt(i),
      grossAmount: 100n + BigInt(i),
      providerAmount: 100n + BigInt(i),
      outcome: "RELEASE",
    }, memPort({ amount: 100n + BigInt(i) }, new Map(), { n: 0n }, { n: 0n })));
  }
  const batch = settlementBatch(receipts);
  assert.equal(batch.count, 3);
  assert.match(batch.root, /^[0-9a-f]{64}$/);
  const path = receiptInclusionProof(receipts, 1);
  assert.equal(verifyReceiptInclusion(receipts[1]!, 1, 3, path, batch.root), true);
  assert.equal(verifyReceiptInclusion(receipts[0]!, 1, 3, path, batch.root), false);
});

test("rejects number amounts and non-conserved instructions", () => {
  const { engine: e } = engine();
  assert.throws(() => e.plan({
    settlementId: "x",
    asset: EUR,
    payerId: "a",
    payeeId: "b",
    escrowAmount: 100 as unknown as bigint,
    grossAmount: 100n,
    providerAmount: 100n,
    outcome: "RELEASE",
  }), /AMOUNT_INVALID/);
  assert.throws(() => e.plan({
    settlementId: "y",
    asset: EUR,
    payerId: "a",
    payeeId: "b",
    escrowAmount: 100n,
    grossAmount: 90n,
    providerAmount: 90n,
    outcome: "RELEASE",
  }), /HOLD_NOT_COMPLETE/);
});
