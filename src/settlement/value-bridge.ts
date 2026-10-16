/**
 * Deposit and withdraw between a UEP-25 note and a Marketplace balance.
 *
 * The Marketplace does not mint value. A deposit spends a client note to the
 * custody account and credits the amount the recipient note holds (the 0.1 %
 * protocol fee stays on the ledger). A withdraw debits the Marketplace
 * balance and spends a custody note back to the client. Captured paymaster
 * gas is spent from custody to the fee account: the ledger treasury id is
 * not a payment recipient. Replay ids are the ledger transaction ids and
 * live in the Marketplace snapshot. This module does not read the clock.
 */
import { parseAmount } from "../core/amount.ts";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { protocolFeeFloor } from "../testnet/ledger.ts";
import { ledgerAssetIdToFr } from "../core/assets.ts";
import { clientBlinding } from "../core/client-note.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { signAction, type MarketplaceIdentity } from "../marketplace/identity.ts";
import type { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import type { UepTransaction } from "../core/transaction.ts";
import type { UepLedger } from "../testnet/ledger.ts";

export type BridgeMove = {
  txId: string;
  asset: string;
  amount: bigint;
  marketplaceBalance: bigint;
};

function feeOf(ledger: { networkId: string }, asset: string, amount: bigint): bigint {
  return creatorFee(amount, protocolFeeFloor(ledger.networkId, ledgerAssetIdToFr(asset)));
}

function received(tx: UepTransaction, recipient: Fr): bigint {
  const want = recipient.toHex();
  const note = tx.outputNotes?.find((n) => (typeof n.owner === "string" ? n.owner : (n.owner as { toHex(): string }).toHex()) === want);
  if (!note) throw new Error("BRIDGE_OUTPUT_MISSING");
  return parseAmount(note.amount as never, "bridge.output");
}

export class ValueBridge {
  readonly ledger: UepLedger;
  readonly marketplace: DigitalServicesMarketplace;
  readonly custody: IdentitySecrets;
  readonly feeAccount: IdentitySecrets;
  readonly admin: MarketplaceIdentity;

  private readonly liability = new Map<string, bigint>();

  constructor(ledger: UepLedger, marketplace: DigitalServicesMarketplace, custody: IdentitySecrets, feeAccount: IdentitySecrets, admin: MarketplaceIdentity) {
    this.ledger = ledger;
    this.marketplace = marketplace;
    this.custody = custody;
    this.feeAccount = feeAccount;
    this.admin = admin;
  }

  /** Custody notes must cover what the bridge has credited and not yet withdrawn. */
  reconcile(asset: string): void {
    const owed = this.liability.get(asset) ?? 0n;
    const have = this.ledger.balanceOf(this.custody.accountId, ledgerAssetIdToFr(asset));
    if (have < owed) throw new Error(`BRIDGE_INSOLVENT: custody ${have} < debt ${owed} for ${asset}`);
  }

  deposit(buyerId: string, secrets: IdentitySecrets, asset: string, amount: bigint, openingSeed: bigint): BridgeMove {
    const built = this.ledger.preparePayment(secrets, this.custody.accountId, asset, amount, this.ledger.height, {
      outputBlinding: clientBlinding(openingSeed),
      changeBlinding: clientBlinding(openingSeed + 1n),
    });
    if ("error" in built) throw new Error(`BRIDGE_DEPOSIT_REJECTED: ${built.error.code}`);
    const applied = this.ledger.submitBatch(built.txs, secrets);
    if ("error" in applied) throw new Error(`BRIDGE_DEPOSIT_REJECTED: ${applied.error.code}`);
    const tx = applied.txs[0];
    if (!tx) throw new Error("BRIDGE_DEPOSIT_REJECTED: no transaction");
    const amountReceived = received(tx, this.custody.accountId);
    const txId = tx.txId.toHex();
    const auth = signAction({
      marketplaceId: this.marketplace.marketplaceId,
      action: "credit",
      actorId: this.admin.identityId,
      target: buyerId,
      details: { asset, amount: amountReceived, creditId: txId },
    }, this.admin.privateKey);
    const marketplaceBalance = this.marketplace.creditAccount(buyerId, asset, amountReceived, { creditId: txId, auth });
    this.liability.set(asset, (this.liability.get(asset) ?? 0n) + amountReceived);
    this.reconcile(asset);
    return { txId, asset, amount: amountReceived, marketplaceBalance };
  }

  withdraw(buyerId: string, recipient: IdentitySecrets, asset: string, amount: bigint, openingSeed: bigint): BridgeMove {
    return this.withdrawTo(buyerId, recipient.accountId, asset, amount, openingSeed);
  }

  /** Recipient is an account id. The caller must already have checked the buyer's authorization. */
  withdrawTo(buyerId: string, recipientAccount: Fr, asset: string, amount: bigint, openingSeed: bigint): BridgeMove {
    const fee = feeOf(this.ledger, asset, amount);
    const debit = amount + fee;
    if (this.marketplace.availableBalance(asset, buyerId) < debit) throw new Error("INSUFFICIENT_FUNDS");
    if ((this.liability.get(asset) ?? 0n) < debit) throw new Error("BRIDGE_INSOLVENT");
    const built = this.ledger.preparePayment(this.custody, recipientAccount, asset, amount, this.ledger.height, {
      outputBlinding: clientBlinding(openingSeed),
      changeBlinding: clientBlinding(openingSeed + 1n),
    });
    if ("error" in built) throw new Error(`BRIDGE_WITHDRAW_REJECTED: ${built.error.code}`);
    const applied = this.ledger.submitBatch(built.txs, this.custody);
    if ("error" in applied) throw new Error(`BRIDGE_WITHDRAW_REJECTED: ${applied.error.code}`);
    const tx = applied.txs[0];
    if (!tx) throw new Error("BRIDGE_WITHDRAW_REJECTED: no transaction");
    const txId = tx.txId.toHex();
    const auth = signAction({
      marketplaceId: this.marketplace.marketplaceId,
      action: "credit",
      actorId: this.admin.identityId,
      target: buyerId,
      details: { asset, amount: debit, creditId: txId },
    }, this.admin.privateKey);
    const marketplaceBalance = this.marketplace.debitAccount(buyerId, asset, debit, { debitId: txId, auth });
    this.liability.set(asset, (this.liability.get(asset) ?? 0n) - debit);
    this.reconcile(asset);
    return { txId, asset, amount, marketplaceBalance };
  }

  sweepGas(asset: string, amount: bigint, openingSeed: bigint): BridgeMove {
    const fee = feeOf(this.ledger, asset, amount);
    const outflow = amount + fee;
    const have = this.ledger.balanceOf(this.custody.accountId, ledgerAssetIdToFr(asset));
    const owed = this.liability.get(asset) ?? 0n;
    if (have < outflow || owed < outflow) throw new Error("BRIDGE_INSOLVENT");
    const built = this.ledger.preparePayment(this.custody, this.feeAccount.accountId, asset, amount, this.ledger.height, {
      outputBlinding: clientBlinding(openingSeed),
      changeBlinding: clientBlinding(openingSeed + 1n),
    });
    if ("error" in built) throw new Error(`BRIDGE_GAS_REJECTED: ${built.error.code}`);
    const applied = this.ledger.submitBatch(built.txs, this.custody);
    if ("error" in applied) throw new Error(`BRIDGE_GAS_REJECTED: ${applied.error.code}`);
    const tx = applied.txs[0];
    if (!tx) throw new Error("BRIDGE_GAS_REJECTED: no transaction");
    const txId = tx.txId.toHex();
    const auth = signAction({
      marketplaceId: this.marketplace.marketplaceId,
      action: "credit",
      actorId: this.admin.identityId,
      target: this.marketplace.adminIdentity,
      details: { asset, amount, creditId: txId },
    }, this.admin.privateKey);
    const left = this.marketplace.consumeGas(asset, amount, { ref: txId, auth });
    this.liability.set(asset, (this.liability.get(asset) ?? 0n) - outflow);
    this.reconcile(asset);
    return { txId, asset, amount, marketplaceBalance: left };
  }

  /** Credit a custody payment to the sender's address identity. The caller verified the signature. */
  claimDeposit(buyerId: string, txId: string): bigint {
    return this.recover("deposit", buyerId, "uep-test/teur", this.receivedAmount(txId), txId);
  }

  receivedAmount(txId: string): bigint {
    const tx = this.ledger.txs.find((item) => item.txId.toHex() === txId);
    if (!tx) throw new Error("BRIDGE_TX_UNKNOWN");
    return received(tx, this.custody.accountId);
  }

  senderOf(txId: string): string {
    const tx = this.ledger.txs.find((item) => item.txId.toHex() === txId);
    if (!tx) throw new Error("BRIDGE_TX_UNKNOWN");
    return tx.senderId.toHex();
  }

  /** Retry the marketplace half of a bridge move whose ledger transaction already landed. */
  recover(kind: "deposit" | "withdraw", buyerId: string, asset: string, amount: bigint, txId: string): bigint {
    let id: Fr;
    try { id = new Fr(txId); } catch { throw new Error("BRIDGE_TX_UNKNOWN"); }
    if (!this.ledger.hasCommittedTx(id)) throw new Error("BRIDGE_TX_UNKNOWN");
    const tx = this.ledger.txs.find((item) => item.txId.toHex() === txId);
    if (!tx) throw new Error("BRIDGE_TX_UNKNOWN");
    if (kind === "deposit") {
      if (received(tx, this.custody.accountId) !== amount) throw new Error("BRIDGE_AMOUNT_MISMATCH");
    } else if (tx.senderId.toHex() !== this.custody.accountId.toHex() || tx.amount !== amount) {
      throw new Error("BRIDGE_AMOUNT_MISMATCH");
    }
    const auth = signAction({
      marketplaceId: this.marketplace.marketplaceId,
      action: "credit",
      actorId: this.admin.identityId,
      target: buyerId,
      details: { asset, amount, creditId: txId },
    }, this.admin.privateKey);
    const balance = kind === "deposit"
      ? this.marketplace.creditAccount(buyerId, asset, amount, { creditId: txId, auth })
      : this.marketplace.debitAccount(buyerId, asset, amount + feeOf(this.ledger, asset, amount), { debitId: txId, auth });
    if (kind === "deposit") this.liability.set(asset, (this.liability.get(asset) ?? 0n) + amount);
    this.reconcile(asset);
    return balance;
  }
}
