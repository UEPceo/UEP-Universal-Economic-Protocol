/**
 * UEP-35.7 — Seeded simulated network (latency, loss, dup, reorder, partition).
 * Does not share application state between nodes.
 */

import { createHash } from "node:crypto";

export type NetMsg = {
  id: string;
  from: string;
  to: string; // "*" = broadcast
  kind: string;
  payload: Uint8Array;
  sentAt: number; // simulation time
};

type Queued = NetMsg & { deliverAt: number };

export type SimNetConfig = {
  seed: number;
  defaultLatencyMs: number;
  lossRate: number; // 0..1
  dupRate: number;
  reorderWindowMs: number;
};

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedNetwork {
  readonly cfg: SimNetConfig;
  private rng: () => number;
  private simTime = 0;
  private queue: Queued[] = [];
  private partitions = new Map<string, Set<string>>(); // node → blocked peers (empty = none)
  private isolated = new Set<string>();
  private seq = 0;
  stats = {
    sent: 0,
    delivered: 0,
    dropped: 0,
    duplicated: 0,
    bytes: 0,
  };

  constructor(cfg: Partial<SimNetConfig> = {}) {
    this.cfg = {
      seed: cfg.seed ?? 1,
      defaultLatencyMs: cfg.defaultLatencyMs ?? 20,
      lossRate: cfg.lossRate ?? 0,
      dupRate: cfg.dupRate ?? 0,
      reorderWindowMs: cfg.reorderWindowMs ?? 0,
    };
    this.rng = mulberry32(this.cfg.seed);
  }

  now(): number {
    return this.simTime;
  }

  advance(ms: number): void {
    this.simTime += ms;
  }

  /** Isolate node from all others */
  isolate(nodeId: string): void {
    this.isolated.add(nodeId);
  }

  reconnect(nodeId: string): void {
    this.isolated.delete(nodeId);
  }

  partition(groupA: string[], groupB: string[]): void {
    for (const a of groupA) {
      const s = this.partitions.get(a) ?? new Set();
      for (const b of groupB) s.add(b);
      this.partitions.set(a, s);
    }
    for (const b of groupB) {
      const s = this.partitions.get(b) ?? new Set();
      for (const a of groupA) s.add(a);
      this.partitions.set(b, s);
    }
  }

  heal(): void {
    this.partitions.clear();
    this.isolated.clear();
  }

  private canReach(from: string, to: string): boolean {
    if (this.isolated.has(from) || this.isolated.has(to)) return false;
    const blocked = this.partitions.get(from);
    if (blocked?.has(to)) return false;
    return true;
  }

  send(
    from: string,
    to: string,
    kind: string,
    payload: Uint8Array,
    latencyMs?: number,
  ): string {
    this.seq++;
    const id = createHash("sha256")
      .update(`${this.cfg.seed}|${this.seq}|${from}|${to}|${kind}`)
      .digest("hex")
      .slice(0, 16);
    const msg: NetMsg = {
      id,
      from,
      to,
      kind,
      payload,
      sentAt: this.simTime,
    };
    this.stats.sent++;
    this.stats.bytes += payload.length;

    if (this.rng() < this.cfg.lossRate) {
      this.stats.dropped++;
      return id;
    }

    const baseLat = latencyMs ?? this.cfg.defaultLatencyMs;
    const jitter = this.cfg.reorderWindowMs * this.rng();
    const deliverAt = this.simTime + baseLat + jitter;
    this.queue.push({ ...msg, deliverAt });
    if (this.rng() < this.cfg.dupRate) {
      this.stats.duplicated++;
      this.queue.push({
        ...msg,
        id: id + "-dup",
        deliverAt: deliverAt + 1 + this.rng() * 5,
      });
    }
    return id;
  }

  broadcast(from: string, peers: string[], kind: string, payload: Uint8Array): void {
    for (const p of peers) {
      if (p === from) continue;
      this.send(from, p, kind, payload);
    }
  }

  /** Deliver all messages due at current simTime. Returns inbox additions by node. */
  drain(): Map<string, NetMsg[]> {
    const out = new Map<string, NetMsg[]>();
    const keep: Queued[] = [];
    for (const m of this.queue) {
      if (m.deliverAt > this.simTime) {
        keep.push(m);
        continue;
      }
      if (!this.canReach(m.from, m.to)) {
        this.stats.dropped++;
        continue;
      }
      const list = out.get(m.to) ?? [];
      list.push(m);
      out.set(m.to, list);
      this.stats.delivered++;
    }
    this.queue = keep;
    return out;
  }
}
