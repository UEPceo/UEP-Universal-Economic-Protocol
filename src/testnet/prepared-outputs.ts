/**
 * v0.5.4: explicit lifecycle for prepared spend outputs.
 *
 * preparation → sent | expired | rejected
 *
 * The ledger does not retain note blinding. Openings travel on the transaction
 * the wallet holds; this table stores only public commitments and the status.
 * Terminal records are capped and never keep secret material.
 */
export type PreparedOutputStatus = "prepared" | "sent" | "expired" | "rejected";

export type PreparedOutputRecord = {
  txId: string;
  status: PreparedOutputStatus;
  preparedAtHeight: number;
  expiresAtHeight: number;
  outputCommitments: string[];
  closedAtHeight?: number;
};

const TERMINAL_CAP = 256;

export class PreparedOutputLifecycle {
  private readonly active = new Map<string, PreparedOutputRecord>();
  private readonly terminal: PreparedOutputRecord[] = [];

  prepare(txId: string, outputCommitments: string[], height: number, ttlHeights: number): PreparedOutputRecord {
    const rec: PreparedOutputRecord = {
      txId,
      status: "prepared",
      preparedAtHeight: height,
      expiresAtHeight: height + Math.max(1, ttlHeights),
      outputCommitments: [...outputCommitments],
    };
    this.active.set(txId, rec);
    return rec;
  }

  markSent(txId: string, height: number): void {
    if (!this.active.has(txId)) {
      const i = this.terminal.findIndex((r) => r.txId === txId);
      if (i >= 0) this.terminal[i] = { ...this.terminal[i]!, status: "sent", closedAtHeight: height };
      return;
    }
    this.close(txId, "sent", height);
  }

  markRejected(txId: string, height: number): void {
    this.close(txId, "rejected", height);
  }

  /** Drop prepared records whose expiry height has passed. Returns how many expired. */
  sweep(height: number): number {
    let n = 0;
    for (const [txId, rec] of this.active) {
      if (rec.status === "prepared" && height >= rec.expiresAtHeight) {
        this.close(txId, "expired", height);
        n++;
      }
    }
    return n;
  }

  get(txId: string): PreparedOutputRecord | undefined {
    return this.active.get(txId) ?? this.terminal.find((r) => r.txId === txId);
  }

  list(): PreparedOutputRecord[] {
    return [...this.active.values(), ...this.terminal];
  }

  private close(txId: string, status: Exclude<PreparedOutputStatus, "prepared">, height: number): void {
    const rec = this.active.get(txId);
    if (!rec) return;
    this.active.delete(txId);
    const closed: PreparedOutputRecord = { ...rec, status, closedAtHeight: height, outputCommitments: [...rec.outputCommitments] };
    this.terminal.push(closed);
    if (this.terminal.length > TERMINAL_CAP) this.terminal.splice(0, this.terminal.length - TERMINAL_CAP);
  }
}
