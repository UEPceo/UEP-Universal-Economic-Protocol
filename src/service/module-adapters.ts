/**
 * Service routes bound to the real modules. LabRelay / LabOracle stay as
 * fallbacks for tests that never attach a node. The node attaches these.
 */
import { createHash } from "node:crypto";
import { completionBps, type ProviderCounters } from "../category/relay.ts";
import { OracleAggregator } from "../oracle/index.ts";
import type { ProviderHealth } from "./provider-model.ts";

const EMPTY_COUNTERS: ProviderCounters = { settledCount: 0, expiredNoFinalCount: 0, fraudProvenCount: 0, distinctRecipients: [] };

export class CategoryRelayAdapter {
  readonly providerId = "category-relay";
  readonly capability = "relay" as const;
  readonly info = { providerId: "category-relay", displayName: "Category relay", capabilities: ["relay" as const], version: "1.0.0" };
  private box: { id: string; body: string; atHeight: number }[] = [];
  private readonly height: () => number;

  constructor(height: () => number) { this.height = height; }

  async health(): Promise<ProviderHealth> {
    const rate = completionBps(EMPTY_COUNTERS);
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: String(this.height()), message: `category/relay store-and-forward (${String(rate)})` };
  }

  async push(id: string, body: string): Promise<{ stored: true; final: false; module: "category/relay" }> {
    if (!this.box.some((e) => e.id === id)) this.box.push({ id, body, atHeight: this.height() });
    return { stored: true, final: false, module: "category/relay" };
  }

  async pull(): Promise<{ id: string; body: string; atHeight: number; final: false; module: "category/relay" }[]> {
    return this.box.map((e) => ({ ...e, final: false as const, module: "category/relay" as const }));
  }
}

export class PolicyOracleAdapter {
  readonly providerId = "policy-oracle";
  readonly capability = "oracle" as const;
  readonly info = { providerId: "policy-oracle", displayName: "Policy oracle", capabilities: ["oracle" as const], version: "1.0.0" };
  readonly aggregator = new OracleAggregator({ requireSignatures: false });
  private readonly height: () => number;
  private readonly posted = new Map<string, string>();

  constructor(height: () => number) { this.height = height; }

  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: String(this.height()), message: "src/oracle policy feed, not settlement" };
  }

  set(feed: string, value: string): void {
    this.posted.set(feed, value);
    this.aggregator.publishSync({
      stage: "VERIFIED",
      baseAssetId: feed,
      quoteAssetId: "REF",
      priceE6: BigInt(value),
      source: "node",
      sequence: 1n,
      observedAtHeight: this.height(),
    });
  }

  async quote(feed: string): Promise<{ feed: string; value: string; confidence: "POLICY"; settles: false }> {
    const read = this.aggregator.read(feed, "REF", this.height());
    const value = read.ok ? read.quote.priceE6.toString() : this.posted.get(feed);
    if (!value) throw new Error("FEED_NOT_FOUND");
    return { feed, value, confidence: "POLICY", settles: false };
  }
}

export class ContentHashCompute {
  readonly providerId = "content-compute";
  readonly capability = "compute" as const;
  readonly info = { providerId: "content-compute", displayName: "Content-hash compute", capabilities: ["compute" as const], version: "1.0.0" };

  async health(): Promise<ProviderHealth> {
    return { status: "HEALTHY", providerId: this.providerId, checkedAt: "0", message: "hash only, no job mint" };
  }

  async submit(programId: string, input: Buffer): Promise<{ jobId: string; outputHash: string; confidence: "LAB" }> {
    if (!programId) throw new Error("PROGRAM_REQUIRED");
    const outputHash = createHash("sha256").update(programId).update(input).digest("hex");
    return { jobId: outputHash.slice(0, 16), outputHash, confidence: "LAB" };
  }
}
