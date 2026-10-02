/**
 * DTN-like store-and-forward with explicit delivery states (35.6.1).
 *
 * ACCEPTED_BY_TRANSPORT ≠ DELIVERED ≠ ACKNOWLEDGED
 */

import type { NetworkAdapter } from "./types.ts";

export type DtnDeliveryState =
  | "ACCEPTED_BY_TRANSPORT"
  | "QUEUED"
  | "FORWARDED"
  | "DELIVERED"
  | "ACKNOWLEDGED";

export type DtnMessage = {
  id: string;
  payload: Uint8Array;
  createdAt: number;
};

/** Bidirectional lab link between two adapters (A ↔ B). */
export class SimulatedLink {
  up = true;
  private ab: Uint8Array[] = [];
  private ba: Uint8Array[] = [];

  setUp(up: boolean): void {
    this.up = up;
  }

  sendAtoB(payload: Uint8Array): { ok: true } | { ok: false; reason: string } {
    if (!this.up) return { ok: false, reason: "LINK_DOWN" };
    this.ab.push(payload);
    return { ok: true };
  }

  sendBtoA(payload: Uint8Array): { ok: true } | { ok: false; reason: string } {
    if (!this.up) return { ok: false, reason: "LINK_DOWN" };
    this.ba.push(payload);
    return { ok: true };
  }

  recvAtB(): Uint8Array | null {
    return this.ab.shift() ?? null;
  }

  recvAtA(): Uint8Array | null {
    return this.ba.shift() ?? null;
  }
}

export class LinkedAdapter implements NetworkAdapter {
  readonly info;
  private side: "A" | "B";
  private link: SimulatedLink;
  constructor(side: "A" | "B", link: SimulatedLink, adapterId: string) {
    this.side = side;
    this.link = link;
    this.info = {
      adapterId,
      transport: "dtn" as const,
      status: link.up ? ("up" as const) : ("down" as const),
    };
  }

  async send(_to: string, payload: Uint8Array) {
    this.info.status = this.link.up ? "up" : "down";
    if (this.side === "A") return this.link.sendAtoB(payload);
    return this.link.sendBtoA(payload);
  }

  async receive() {
    const p = this.side === "A" ? this.link.recvAtA() : this.link.recvAtB();
    if (!p) return null;
    return {
      from: this.side === "A" ? "B" : "A",
      payload: p,
    };
  }

  estimateLatencyMs() {
    return 50;
  }
  estimateBandwidthMbps() {
    return 100;
  }
  availability() {
    return this.link.up ? 1 : 0;
  }
  connectivityStatus() {
    return this.link.up ? ("up" as const) : ("down" as const);
  }
  observe() {
    return {
      transport: "dtn" as const,
      latencyMs: 50,
      jitterMs: 5,
      packetLoss: this.link.up ? 0 : 1,
      bandwidthMbps: 100,
      availability: this.link.up ? 1 : 0,
      timestamp: Date.now(),
      source: this.info.adapterId,
      confidence: "SIMULATED" as const,
    };
  }
}

export class DtnBridge {
  private adapter: NetworkAdapter;
  private pending: DtnMessage[] = [];
  private state = new Map<string, DtnDeliveryState>();
  stats = {
    queued: 0,
    acceptedByTransport: 0,
    delivered: 0,
    acknowledged: 0,
    duplicates: 0,
  };

  constructor(adapter: NetworkAdapter) {
    this.adapter = adapter;
  }

  getState(id: string): DtnDeliveryState | undefined {
    return this.state.get(id);
  }

  async send(msg: DtnMessage): Promise<DtnDeliveryState> {
    if (this.state.get(msg.id) === "ACKNOWLEDGED" || this.state.get(msg.id) === "DELIVERED") {
      this.stats.duplicates++;
      return this.state.get(msg.id)!;
    }
    const r = await this.adapter.send("remote", msg.payload);
    if (r.ok) {
      this.state.set(msg.id, "ACCEPTED_BY_TRANSPORT");
      this.stats.acceptedByTransport++;
      return "ACCEPTED_BY_TRANSPORT";
    }
    this.pending.push(msg);
    this.state.set(msg.id, "QUEUED");
    this.stats.queued++;
    return "QUEUED";
  }

  /** Poll local adapter receive → mark DELIVERED for matching pending ids (lab). */
  async pollDelivered(expectedIds: string[]): Promise<number> {
    let n = 0;
    for (;;) {
      const m = await this.adapter.receive();
      if (!m) break;
      // payload is opaque; lab counts any receive as delivery progress
      for (const id of expectedIds) {
        const st = this.state.get(id);
        if (st === "ACCEPTED_BY_TRANSPORT" || st === "FORWARDED") {
          this.state.set(id, "DELIVERED");
          this.stats.delivered++;
          n++;
        }
      }
    }
    return n;
  }

  /** Caller observed payload at remote endpoint. */
  markRemoteDelivered(id: string): void {
    const st = this.state.get(id);
    if (st === "ACCEPTED_BY_TRANSPORT" || st === "FORWARDED") {
      this.state.set(id, "DELIVERED");
      this.stats.delivered++;
    }
  }

  acknowledge(id: string): void {
    if (this.state.get(id) === "DELIVERED") {
      this.state.set(id, "ACKNOWLEDGED");
      this.stats.acknowledged++;
    }
  }

  async retry(): Promise<number> {
    let n = 0;
    const left: DtnMessage[] = [];
    for (const msg of this.pending) {
      const r = await this.adapter.send("remote", msg.payload);
      if (r.ok) {
        this.state.set(msg.id, "ACCEPTED_BY_TRANSPORT");
        this.stats.acceptedByTransport++;
        n++;
      } else left.push(msg);
    }
    this.pending = left;
    return n;
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
