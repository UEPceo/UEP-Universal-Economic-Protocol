/**
 * UEP Marketplace Paymaster v0.1
 *
 * Gas is paid in the same asset as the purchase. There is no native UEP token
 * and no hidden FX conversion: the paymaster quotes a bounded gas amount,
 * reserves that amount, and recovers it from the buyer's escrow at settlement.
 * The buyer therefore sees one deterministic checkout total before payment.
 */
export const PAYMASTER_VERSION = "0.1" as const;

export type GasQuote = {
  quoteId: string;
  asset: string;
  gasUnits: bigint;
  gasPricePerUnit: bigint;
  gasFee: bigint;
  quotedAt: number;
  expiresAt: number;
  maxSlippageBps: number;
  oracleRef: string;
};

export type PaymasterReceipt = {
  quoteId: string;
  orderId: string;
  asset: string;
  gasFee: bigint;
  capturedAt: number;
};

export type GasPriceOracle = (input: { asset: string; gasUnits: bigint; now: number }) => {
  gasPricePerUnit: bigint;
  oracleRef: string;
  maxSlippageBps?: number;
};

export type PaymasterConfig = {
  paymasterId?: string;
  quoteTtlMs?: number;
  oracle?: GasPriceOracle;
  now?: () => number;
};

function quoteId(asset: string, gasUnits: bigint, at: number): string {
  return `gasq_${asset}_${gasUnits.toString()}_${at}`;
}

export class MarketplacePaymaster {
  readonly version = PAYMASTER_VERSION;
  readonly paymasterId: string;
  readonly quoteTtlMs: number;
  private readonly oracle: GasPriceOracle;
  private readonly now: () => number;
  private readonly reserves = new Map<string, bigint>();
  private readonly sponsored = new Map<string, GasQuote>();
  private readonly captured = new Set<string>();
  readonly receipts: PaymasterReceipt[] = [];

  constructor(config: PaymasterConfig = {}) {
    this.paymasterId = config.paymasterId ?? "marketplace-paymaster";
    this.quoteTtlMs = config.quoteTtlMs ?? 10 * 60 * 1000;
    this.now = config.now ?? (() => Date.now());
    this.oracle = config.oracle ?? (() => ({ gasPricePerUnit: 1n, oracleRef: "deterministic-local-gas", maxSlippageBps: 100 }));
  }

  fundReserve(asset: string, amount: bigint): void {
    if (!asset) throw new Error("ASSET_REQUIRED");
    if (amount <= 0n) throw new Error("INVALID_RESERVE_AMOUNT");
    this.reserves.set(asset, (this.reserves.get(asset) ?? 0n) + amount);
  }

  reserveOf(asset: string): bigint {
    return this.reserves.get(asset) ?? 0n;
  }

  quote(asset: string, gasUnits: bigint, now = this.now()): GasQuote {
    if (!asset) throw new Error("ASSET_REQUIRED");
    if (gasUnits <= 0n) throw new Error("INVALID_GAS_UNITS");
    const o = this.oracle({ asset, gasUnits, now });
    if (o.gasPricePerUnit < 0n) throw new Error("INVALID_GAS_PRICE");
    const gasFee = gasUnits * o.gasPricePerUnit;
    return {
      quoteId: quoteId(asset, gasUnits, now),
      asset,
      gasUnits,
      gasPricePerUnit: o.gasPricePerUnit,
      gasFee,
      quotedAt: now,
      expiresAt: now + this.quoteTtlMs,
      maxSlippageBps: o.maxSlippageBps ?? 100,
      oracleRef: o.oracleRef,
    };
  }

  sponsor(orderId: string, quote: GasQuote, now = this.now()): GasQuote {
    if (!orderId) throw new Error("ORDER_ID_REQUIRED");
    if (now > quote.expiresAt) throw new Error("GAS_QUOTE_EXPIRED");
    if (quote.gasFee < 0n || quote.gasUnits <= 0n || quote.gasPricePerUnit < 0n) throw new Error("INVALID_GAS_QUOTE");
    const fresh = this.quote(quote.asset, quote.gasUnits, quote.quotedAt);
    if (fresh.quoteId !== quote.quoteId || fresh.gasFee !== quote.gasFee || fresh.gasPricePerUnit !== quote.gasPricePerUnit || fresh.oracleRef !== quote.oracleRef) {
      throw new Error("GAS_QUOTE_TAMPERED");
    }
    if ((this.reserves.get(quote.asset) ?? 0n) < quote.gasFee) throw new Error("PAYMASTER_RESERVE_INSUFFICIENT");
    const key = `${orderId}:${quote.quoteId}`;
    if (this.sponsored.has(key)) return this.sponsored.get(key)!;
    this.reserves.set(quote.asset, (this.reserves.get(quote.asset) ?? 0n) - quote.gasFee);
    this.sponsored.set(key, { ...quote });
    return { ...quote };
  }

  sponsoredQuote(orderId: string, quoteId: string): GasQuote {
    const quote = this.sponsored.get(`${orderId}:${quoteId}`);
    if (!quote) throw new Error("PAYMASTER_SPONSOR_NOT_FOUND");
    return { ...quote };
  }

  capture(orderId: string, quote: GasQuote, now = this.now()): PaymasterReceipt {
    const key = `${orderId}:${quote.quoteId}`;
    if (this.captured.has(key)) {
      const existing = this.receipts.find((r) => r.orderId === orderId && r.quoteId === quote.quoteId);
      if (!existing) throw new Error("PAYMASTER_RECEIPT_MISSING");
      return { ...existing };
    }
    if (!this.sponsored.has(key)) throw new Error("PAYMASTER_SPONSOR_REQUIRED");
    // The sponsor advanced the fee at quote time; settlement repays that advance from buyer escrow.
    this.reserves.set(quote.asset, (this.reserves.get(quote.asset) ?? 0n) + quote.gasFee);
    const receipt: PaymasterReceipt = { quoteId: quote.quoteId, orderId, asset: quote.asset, gasFee: quote.gasFee, capturedAt: now };
    this.captured.add(key);
    this.receipts.push(receipt);
    return { ...receipt };
  }

  /** A failed pre-settlement order releases the sponsor reserve. */
  release(orderId: string, quote: GasQuote): void {
    const key = `${orderId}:${quote.quoteId}`;
    if (!this.sponsored.has(key) || this.captured.has(key)) return;
    this.reserves.set(quote.asset, (this.reserves.get(quote.asset) ?? 0n) + quote.gasFee);
    this.sponsored.delete(key);
  }
}
