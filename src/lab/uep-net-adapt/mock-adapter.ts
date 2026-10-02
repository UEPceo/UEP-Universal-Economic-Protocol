import type {
  NetworkAdapter,
  NetworkAdapterInfo,
  NetworkObservation,
  ConnectivityStatus,
  TransportType,
} from "./types.ts";

export class MockNetworkAdapter implements NetworkAdapter {
  readonly info: NetworkAdapterInfo;
  private queue: Array<{ from: string; payload: Uint8Array }> = [];
  private latentMs: number;
  private bw: number;
  private avail: number;
  private status: ConnectivityStatus;

  constructor(opts: {
    adapterId: string;
    transport?: TransportType;
    latencyMs?: number;
    bandwidthMbps?: number;
    availability?: number;
    status?: ConnectivityStatus;
  }) {
    this.info = {
      adapterId: opts.adapterId,
      transport: opts.transport ?? "mock",
      status: opts.status ?? "up",
    };
    this.latentMs = opts.latencyMs ?? 10;
    this.bw = opts.bandwidthMbps ?? 100;
    this.avail = opts.availability ?? 0.99;
    this.status = opts.status ?? "up";
  }

  setStatus(s: ConnectivityStatus): void {
    this.status = s;
    this.info.status = s;
  }

  async send(
    to: string,
    payload: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.status === "down") return { ok: false, reason: "LINK_DOWN" };
    // echo into local queue as if delivered to peer (sim)
    this.queue.push({ from: this.info.adapterId, payload });
    void to;
    return { ok: true };
  }

  async receive(): Promise<{ from: string; payload: Uint8Array } | null> {
    return this.queue.shift() ?? null;
  }

  estimateLatencyMs(): number {
    return this.latentMs;
  }
  estimateBandwidthMbps(): number {
    return this.bw;
  }
  availability(): number {
    return this.avail;
  }
  connectivityStatus(): ConnectivityStatus {
    return this.status;
  }
  observe(): NetworkObservation {
    return {
      transport: this.info.transport,
      latencyMs: this.latentMs,
      jitterMs: this.latentMs * 0.1,
      packetLoss: this.status === "degraded" ? 0.05 : 0,
      bandwidthMbps: this.bw,
      availability: this.avail,
      timestamp: Date.now(),
      source: this.info.adapterId,
      confidence: "MEASURED",
    };
  }
}
