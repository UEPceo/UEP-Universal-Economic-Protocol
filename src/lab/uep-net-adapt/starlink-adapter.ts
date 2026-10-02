/**
 * StarlinkAdapter — EXPERIMENTAL simulator / interface placeholder.
 *
 * NOT a live Starlink integration. No private SpaceX APIs.
 * mock → SIMULATED; recorded → MEASURED_RECORDED; local_optional reserved (still not live).
 */

import type {
  NetworkAdapter,
  NetworkAdapterInfo,
  NetworkObservation,
  ConnectivityStatus,
  ObservationConfidence,
} from "./types.ts";
import { validateObservation } from "./types.ts";

export type StarlinkProvider = "mock" | "recorded" | "local_optional";

export type StarlinkRecordedSample = {
  latencyMs: number;
  bandwidthMbps: number;
  availability: number;
  status: ConnectivityStatus;
  at: number;
};

export class StarlinkAdapter implements NetworkAdapter {
  readonly info: NetworkAdapterInfo;
  private provider: StarlinkProvider;
  private samples: StarlinkRecordedSample[];
  private idx = 0;
  private queue: Array<{ from: string; payload: Uint8Array }> = [];
  private storeForward: Uint8Array[] = [];
  private linkUp: boolean;

  constructor(opts?: {
    adapterId?: string;
    provider?: StarlinkProvider;
    recorded?: StarlinkRecordedSample[];
    initialUp?: boolean;
  }) {
    this.provider = opts?.provider ?? "mock";
    this.samples = opts?.recorded ?? [
      {
        latencyMs: 40,
        bandwidthMbps: 200,
        availability: 0.99,
        status: "up",
        at: Date.now(),
      },
    ];
    this.linkUp = opts?.initialUp ?? true;
    this.info = {
      adapterId: opts?.adapterId ?? "starlink-lab-0",
      transport: "starlink",
      status: this.linkUp ? "up" : "down",
    };
  }

  setLinkUp(up: boolean): void {
    this.linkUp = up;
    this.info.status = up ? "up" : "down";
  }

  private confidence(): ObservationConfidence {
    if (this.provider === "mock") return "SIMULATED";
    if (this.provider === "recorded") return "MEASURED_RECORDED";
    // local_optional: not actually connected → do not claim MEASURED
    return "SELF_REPORTED";
  }

  async send(
    to: string,
    payload: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    void to;
    if (!this.linkUp) {
      this.storeForward.push(payload);
      return { ok: false, reason: "QUEUED_STORE_FORWARD" };
    }
    this.queue.push({ from: this.info.adapterId, payload });
    return { ok: true };
  }

  flushQueue(): number {
    if (!this.linkUp) return 0;
    let n = 0;
    while (this.storeForward.length) {
      const p = this.storeForward.shift()!;
      this.queue.push({ from: this.info.adapterId, payload: p });
      n++;
    }
    return n;
  }

  async receive(): Promise<{ from: string; payload: Uint8Array } | null> {
    return this.queue.shift() ?? null;
  }

  estimateLatencyMs(): number {
    return this.samples[this.idx % this.samples.length]!.latencyMs;
  }
  estimateBandwidthMbps(): number {
    return this.samples[0]?.bandwidthMbps ?? 100;
  }
  availability(): number {
    return this.samples[0]?.availability ?? 0.99;
  }
  connectivityStatus(): ConnectivityStatus {
    return this.linkUp ? "up" : "down";
  }

  observe(): NetworkObservation {
    const s = this.samples[this.idx % this.samples.length]!;
    this.idx++;
    const o: NetworkObservation = {
      transport: "starlink",
      latencyMs: s.latencyMs,
      jitterMs: 5,
      packetLoss: this.linkUp ? 0.001 : 1,
      bandwidthMbps: s.bandwidthMbps,
      availability: s.availability,
      timestamp: Date.now(),
      source: this.info.adapterId,
      confidence: this.confidence(),
    };
    const v = validateObservation(o);
    if (!v.ok) {
      return { ...o, confidence: "SELF_REPORTED", bandwidthMbps: 0 };
    }
    return o;
  }
}
