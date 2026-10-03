/**
 * UEP-API-001.2 — lab backends for spend submit, compute, relay, oracle.
 * None of these write consensus state. A missing backend is an API error, not a halt.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ProviderHealth } from "./provider-model.ts";

/** Canonical spend id (same format as the lab replica: domain|sender|nonce). */
export function canonicalSpendId(domainId: string, sender: string, nonceOrNullifier: string): string {
  return `${domainId}|${sender}|${nonceOrNullifier}`;
}

export type SpendSubmitInput = {
  sender: string;
  recipient: string;
  amount: string;
  assetId?: string;
  nonce: string;
  domainId: string;
  authHex?: string;
};

export type SpendSubmitResult = {
  spendId: string;
  status: "QUEUED" | "REJECTED";
  final: false;
  reason?: string;
};

export type SpendExecutor = (input: SpendSubmitInput) => Promise<{ accepted: boolean; reason?: string }>;

export class SpendInbox {
  private seen = new Set<string>();
  private executor?: SpendExecutor;
  constructor(executor?: SpendExecutor) {
    this.executor = executor;
  }

  async submit(input: SpendSubmitInput): Promise<SpendSubmitResult> {
    if (!input.domainId) return { spendId: "", status: "REJECTED", final: false, reason: "DOMAIN_REQUIRED" };
    if (!input.sender || !input.recipient || !input.nonce) {
      return { spendId: "", status: "REJECTED", final: false, reason: "INVALID_REQUEST" };
    }
    let amount: bigint;
    try { amount = BigInt(input.amount); } catch { return { spendId: "", status: "REJECTED", final: false, reason: "BAD_AMOUNT" }; }
    if (amount <= 0n) return { spendId: "", status: "REJECTED", final: false, reason: "BAD_AMOUNT" };
    const key = canonicalSpendId(input.domainId, input.sender, input.nonce);
    if (this.seen.has(key)) return { spendId: key, status: "REJECTED", final: false, reason: "REPLAY" };
    if (this.executor) {
      const r = await this.executor(input);
      if (!r.accepted) return { spendId: key, status: "REJECTED", final: false, reason: r.reason ?? "EXECUTOR_REJECT" };
    }
    this.seen.add(key);
    return { spendId: key, status: "QUEUED", final: false };
  }
}

export class LabCompute {
  readonly providerId = "lab-compute";
  readonly capability = "compute" as const;
  readonly info = { providerId: "lab-compute", displayName: "Lab compute", capabilities: ["compute" as const], version: "1.1.0" };
  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: new Date().toISOString(), message: "LAB" };
  }
  async submit(programId: string, input: Buffer): Promise<{ jobId: string; outputHash: string; confidence: "LAB" }> {
    if (!programId) throw new Error("PROGRAM_REQUIRED");
    const outputHash = createHash("sha256").update(programId).update(input).digest("hex");
    return { jobId: randomBytes(8).toString("hex"), outputHash, confidence: "LAB" };
  }
}

export class LabRelay {
  readonly providerId = "lab-relay";
  readonly capability = "relay" as const;
  readonly info = { providerId: "lab-relay", displayName: "Lab relay", capabilities: ["relay" as const], version: "1.1.0" };
  private box: { id: string; body: string; at: string }[] = [];
  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: new Date().toISOString(), message: "LAB store-and-forward" };
  }
  async push(id: string, body: string): Promise<{ stored: true; final: false }> {
    if (this.box.some((e) => e.id === id)) return { stored: true, final: false };
    this.box.push({ id, body, at: new Date().toISOString() });
    return { stored: true, final: false };
  }
  async pull(): Promise<{ id: string; body: string; at: string; final: false }[]> {
    return this.box.map((e) => ({ ...e, final: false as const }));
  }
}

export class LabOracle {
  readonly providerId = "lab-oracle";
  readonly capability = "oracle" as const;
  readonly info = { providerId: "lab-oracle", displayName: "Lab oracle", capabilities: ["oracle" as const], version: "1.1.0" };
  private feeds = new Map<string, { value: string; confidence: "LAB" }>();
  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: new Date().toISOString(), message: "LAB quote, not settlement" };
  }
  set(feed: string, value: string): void {
    this.feeds.set(feed, { value, confidence: "LAB" });
  }
  async quote(feed: string): Promise<{ feed: string; value: string; confidence: "LAB"; settles: false }> {
    const row = this.feeds.get(feed);
    if (!row) throw new Error("FEED_NOT_FOUND");
    return { feed, value: row.value, confidence: "LAB", settles: false };
  }
}
