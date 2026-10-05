/**
 * Index of settled category work (v0.5.2). Only swap and relay write through a
 * once-issued writer. Drip reads it: a node cannot declare its own work.
 * feeCollected is bigint; settledAt is a block height (ADR 0001 / 0002).
 */
export interface SettledWork {
  orderId: string;
  category: "swap" | "relay";
  providerId: string;
  asset: string;
  feeCollected: bigint;
  receiptHash: string;
  settledAt: number;
}

export type IndexWriter = (work: SettledWork) => void;

export class SettlementIndex {
  private rows = new Map<string, SettledWork>();
  private issued = new Set<string>();

  issueWriter(module: string): IndexWriter {
    if (this.issued.has(module)) throw new Error("INDEX_WRITER_ALREADY_ISSUED");
    this.issued.add(module);
    return (work) => {
      if (typeof work.feeCollected !== "bigint" || work.feeCollected < 0n) throw new Error("AMOUNT_INVALID");
      if (!Number.isSafeInteger(work.settledAt) || work.settledAt < 0) throw new Error("HEIGHT_INVALID");
      if (this.rows.has(work.orderId)) throw new Error("INDEX_DUPLICATE");
      this.rows.set(work.orderId, { ...work });
    };
  }

  get(orderId: string): SettledWork | undefined {
    const w = this.rows.get(orderId);
    return w ? { ...w } : undefined;
  }
}
