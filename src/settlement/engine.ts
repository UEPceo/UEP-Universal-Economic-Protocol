/**
 * Settlement engine (v0.5.2): the single payout executor behind the
 * Marketplace and the swap / relay categories.
 *
 * execute() runs in two phases:
 *  1. plan (pure): validate the instruction, quote the Marketplace fee from
 *     the treasury, check the paymaster quote is the sponsored one, check the
 *     treasury has not already settled this id, and check conservation:
 *       escrow = providerNet + marketplaceFee + gasCaptured + buyerRefund
 *       buyerRefund = (gross - providerAmount) + (gas - gasCaptured)
 *  2. commit: paymaster capture or release, treasury fee allocation
 *     (40/25/20/15, remainder to OPERATIONS), escrow close and credits through
 *     the owner's SettlementLedgerPort, receipt.
 * Every check that can fail runs in phase 1, so phase 2 never stops half way.
 *
 * Fee rule (one path): the Marketplace fee max(1, floor(x * 300 / 10000)) is
 * charged only on the provider part x of a settlement (x > 0). The protocol
 * fee applies to ledger spends only (src/core/fee.ts) and never here.
 *
 * The engine reads no clock: the height comes from the injected HeightSource
 * (ADR 0002). It holds no balances and no order state.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.ts";
import type { HeightSource } from "../core/height.ts";
import type { MarketplaceTreasury } from "../marketplace/economy.ts";
import type { MarketplacePaymaster } from "../marketplace/paymaster.ts";
import {
  SETTLEMENT_RECEIPT_DOMAIN,
  SETTLEMENT_RECEIPT_VERSION,
  type PayoutInstruction,
  type SettlementLedgerPort,
  type SettlementPlan,
  type SettlementReceipt,
} from "./types.ts";

const OUTCOMES = new Set(["RELEASE", "REFUND_BUYER", "SPLIT"]);

function assertAmount(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`AMOUNT_INVALID: ${label} must be a non-negative bigint`);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`SETTLEMENT_ID_INVALID: ${label}`);
}

/** Canonical hash of a receipt body (every field except receiptHash). */
export function settlementReceiptHash(body: Omit<SettlementReceipt, "receiptHash">): string {
  return createHash("sha256").update(canonicalJson([SETTLEMENT_RECEIPT_DOMAIN, body])).digest("hex");
}

/** True when `receipt.receiptHash` matches its fields. */
export function verifySettlementReceipt(receipt: SettlementReceipt): boolean {
  const { receiptHash, ...body } = receipt;
  try {
    return typeof receiptHash === "string" && settlementReceiptHash(body) === receiptHash;
  } catch {
    return false;
  }
}

export type SettlementEngineConfig = {
  treasury: MarketplaceTreasury;
  paymaster?: MarketplacePaymaster;
  height: HeightSource;
};

export class SettlementEngine {
  readonly treasury: MarketplaceTreasury;
  readonly paymaster?: MarketplacePaymaster;
  private readonly height: HeightSource;
  private readonly receipts = new Map<string, SettlementReceipt>();
  private executing = false;

  constructor(config: SettlementEngineConfig) {
    if (!config || !config.treasury || typeof config.height !== "function") throw new Error("SETTLEMENT_ENGINE_CONFIG_INVALID");
    this.treasury = config.treasury;
    this.paymaster = config.paymaster;
    this.height = config.height;
  }

  /** Validate and price an instruction without moving anything. */
  plan(instruction: PayoutInstruction): SettlementPlan {
    if (!instruction || typeof instruction !== "object") throw new Error("SETTLEMENT_INSTRUCTION_INVALID");
    const { settlementId, asset, payerId, payeeId, escrowAmount, grossAmount, providerAmount, outcome } = instruction;
    assertId(settlementId, "settlementId");
    assertId(asset, "asset");
    assertId(payerId, "payerId");
    assertId(payeeId, "payeeId");
    assertAmount(escrowAmount, "escrowAmount");
    assertAmount(grossAmount, "grossAmount");
    assertAmount(providerAmount, "providerAmount");
    if (!OUTCOMES.has(outcome)) throw new Error("DISPUTE_OUTCOME_INVALID");
    if (this.receipts.has(settlementId)) throw new Error("SETTLEMENT_ALREADY_EXECUTED");
    const gas = instruction.gas?.fee ?? 0n;
    assertAmount(gas, "gas.fee");
    if (escrowAmount !== grossAmount + gas) throw new Error("HOLD_NOT_COMPLETE");
    if (providerAmount > grossAmount) throw new Error("PAYOUT_AMOUNT_INVALID");
    if (outcome === "RELEASE" && providerAmount !== grossAmount) throw new Error("PAYOUT_AMOUNT_INVALID");
    if (outcome === "REFUND_BUYER" && providerAmount !== 0n) throw new Error("PAYOUT_AMOUNT_INVALID");
    if (outcome === "SPLIT" && (providerAmount === 0n || providerAmount === grossAmount)) throw new Error("PAYOUT_AMOUNT_INVALID");
    let marketplaceFee = 0n;
    let providerNet = 0n;
    let gasCaptured = 0n;
    if (providerAmount > 0n) {
      if (this.treasury.hasSettled(settlementId)) throw new Error("FEE_ALREADY_SETTLED");
      if (gas > 0n) {
        const quoteId = instruction.gas?.quoteId;
        if (!this.paymaster || !quoteId) throw new Error("PAYMASTER_STATE_MISSING");
        const quote = this.paymaster.sponsoredQuote(settlementId, quoteId);
        if (quote.asset !== asset || quote.gasFee !== gas) throw new Error("GAS_QUOTE_MISMATCH");
        gasCaptured = gas;
      }
      const quote = this.treasury.quote(providerAmount, asset);
      marketplaceFee = quote.marketplaceFee;
      providerNet = quote.providerNet;
    }
    const buyerRefund = escrowAmount - providerNet - marketplaceFee - gasCaptured;
    if (buyerRefund < 0n || buyerRefund !== grossAmount - providerAmount + (gas - gasCaptured)) throw new Error("PAYOUT_NOT_CONSERVED");
    if (providerNet + marketplaceFee + gasCaptured + buyerRefund !== escrowAmount) throw new Error("PAYOUT_NOT_CONSERVED");
    return { instruction: { ...instruction, gas: instruction.gas ? { ...instruction.gas } : undefined }, marketplaceFee, providerNet, gasCaptured, buyerRefund };
  }

  /** Plan, then commit through `port`. Throws before any move if anything is wrong. */
  execute(instruction: PayoutInstruction, port: SettlementLedgerPort): SettlementReceipt {
    if (this.executing) throw new Error("SETTLEMENT_REENTRANT");
    this.executing = true;
    try {
      const plan = this.plan(instruction);
      const i = plan.instruction;
      if (port.escrowBalance(i) < i.escrowAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");
      const height = this.height();
      // Commit. Nothing below can fail for a valid plan.
      if (plan.gasCaptured > 0n) {
        this.paymaster!.capture(i.settlementId, this.paymaster!.sponsoredQuote(i.settlementId, i.gas!.quoteId!), height);
      } else if (i.providerAmount === 0n && i.gas && i.gas.fee > 0n && i.gas.quoteId && this.paymaster) {
        this.paymaster.release(i.settlementId, { quoteId: i.gas.quoteId });
      }
      if (i.providerAmount > 0n) {
        const settled = this.treasury.settleMarketplaceFee(i.settlementId, i.providerAmount, i.asset, height);
        if (settled.marketplaceFee !== plan.marketplaceFee) throw new Error("FEE_QUOTE_CHANGED");
      }
      port.closeEscrow(i, i.escrowAmount);
      if (plan.providerNet > 0n) port.credit(i.payeeId, i.asset, plan.providerNet);
      if (plan.buyerRefund > 0n) port.credit(i.payerId, i.asset, plan.buyerRefund);
      if (plan.marketplaceFee > 0n) port.recordFee(i.asset, plan.marketplaceFee);
      if (plan.gasCaptured > 0n) port.recordGas(i.asset, plan.gasCaptured);
      const body: Omit<SettlementReceipt, "receiptHash"> = {
        version: SETTLEMENT_RECEIPT_VERSION,
        settlementId: i.settlementId,
        asset: i.asset,
        payerId: i.payerId,
        payeeId: i.payeeId,
        grossAmount: i.grossAmount,
        providerAmount: i.providerAmount,
        marketplaceFee: plan.marketplaceFee,
        providerNet: plan.providerNet,
        gasCaptured: plan.gasCaptured,
        buyerRefund: plan.buyerRefund,
        outcome: i.outcome,
        height,
        treasuryId: this.treasury.treasuryId,
      };
      const receipt: SettlementReceipt = Object.freeze({ ...body, receiptHash: settlementReceiptHash(body) });
      this.receipts.set(i.settlementId, receipt);
      return { ...receipt };
    } finally {
      this.executing = false;
    }
  }

  hasExecuted(settlementId: string): boolean {
    return this.receipts.has(settlementId);
  }

  receipt(settlementId: string): SettlementReceipt | undefined {
    const r = this.receipts.get(settlementId);
    return r ? { ...r } : undefined;
  }

  /** Receipts in execution order (copies). */
  receiptsList(): SettlementReceipt[] {
    return [...this.receipts.values()].map((r) => ({ ...r }));
  }
}
