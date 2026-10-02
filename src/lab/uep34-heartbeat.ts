/**
 * UEP-34.1 / 34.3 — Leader heartbeat with monotonic counter (anti-replay).
 */

import type { NodeIdentity } from "./node-identity.ts";
import { signBytes, verifyBytes } from "./node-identity.ts";

export type HeartbeatMsg = {
  type: "heartbeat";
  networkId: string;
  domainId: number;
  epoch: number;
  leaderNodeId: string;
  /** Monotonic per (leader, epoch); must strictly increase. */
  counter: number;
  sequence: number;
  stateRoot: string;
  ts: number;
  signature: string;
};

export function heartbeatBody(m: Omit<HeartbeatMsg, "type" | "signature">): string {
  return [
    "UEP-34-HB",
    m.networkId,
    String(m.domainId),
    String(m.epoch),
    m.leaderNodeId,
    String(m.counter),
    String(m.sequence),
    m.stateRoot,
    String(m.ts),
  ].join("|");
}

export function signHeartbeat(
  identity: NodeIdentity,
  partial: Omit<HeartbeatMsg, "type" | "signature" | "leaderNodeId">,
): HeartbeatMsg {
  const msg: Omit<HeartbeatMsg, "signature"> = {
    type: "heartbeat",
    ...partial,
    leaderNodeId: identity.nodeId,
  };
  return { ...msg, signature: signBytes(identity, heartbeatBody(msg)) };
}

export function verifyHeartbeat(
  msg: HeartbeatMsg,
  leaderPublicKeyHex: string,
  expected: {
    networkId: string;
    domainId: number;
    epoch: number;
    leaderNodeId: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (msg.networkId !== expected.networkId) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (msg.domainId !== expected.domainId) return { ok: false, reason: "DOMAIN_MISMATCH" };
  if (msg.epoch !== expected.epoch) return { ok: false, reason: "EPOCH_MISMATCH" };
  if (msg.leaderNodeId !== expected.leaderNodeId) {
    return { ok: false, reason: "LEADER_MISMATCH" };
  }
  if (!Number.isInteger(msg.counter) || msg.counter < 0) {
    return { ok: false, reason: "BAD_COUNTER" };
  }
  if (!verifyBytes(leaderPublicKeyHex, heartbeatBody(msg), msg.signature)) {
    return { ok: false, reason: "BAD_HEARTBEAT_SIGNATURE" };
  }
  return { ok: true };
}

export type SilenceHandler = (info: {
  leaderNodeId: string;
  epoch: number;
  lastSeenMs: number;
  lastCounter: number;
}) => void;

export class HeartbeatMonitor {
  private timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenMs = 0;
  private lastCounter = -1;
  private leaderNodeId: string;
  private epoch: number;
  private onSilence: SilenceHandler;
  private stopped = false;

  constructor(opts: {
    timeoutMs: number;
    leaderNodeId: string;
    epoch: number;
    onSilence: SilenceHandler;
  }) {
    this.timeoutMs = opts.timeoutMs;
    this.leaderNodeId = opts.leaderNodeId;
    this.epoch = opts.epoch;
    this.onSilence = opts.onSilence;
    this.arm();
  }

  /**
   * Accept only if counter > lastCounter for this leader/epoch.
   * Returns false on replay / stale counter.
   */
  feed(
    leaderNodeId: string,
    epoch: number,
    counter?: number,
  ): boolean {
    if (this.stopped) return false;
    if (leaderNodeId !== this.leaderNodeId || epoch !== this.epoch) return false;
    if (counter !== undefined) {
      if (!Number.isInteger(counter) || counter <= this.lastCounter) {
        return false; // replay or non-monotonic
      }
      this.lastCounter = counter;
    }
    this.lastSeenMs = Date.now();
    this.arm();
    return true;
  }

  resetLeader(leaderNodeId: string, epoch: number): void {
    this.leaderNodeId = leaderNodeId;
    this.epoch = epoch;
    this.lastCounter = -1;
    this.lastSeenMs = Date.now();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.onSilence({
        leaderNodeId: this.leaderNodeId,
        epoch: this.epoch,
        lastSeenMs: this.lastSeenMs,
        lastCounter: this.lastCounter,
      });
    }, this.timeoutMs);
  }
}

export class HeartbeatTicker {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private identity: NodeIdentity;
  private counter = 0;
  private getMeta: () => {
    networkId: string;
    domainId: number;
    epoch: number;
    sequence: number;
    stateRoot: string;
  };
  private onBeat: (hb: HeartbeatMsg) => void;

  constructor(opts: {
    intervalMs: number;
    identity: NodeIdentity;
    getMeta: () => {
      networkId: string;
      domainId: number;
      epoch: number;
      sequence: number;
      stateRoot: string;
    };
    onBeat: (hb: HeartbeatMsg) => void;
  }) {
    this.intervalMs = opts.intervalMs;
    this.identity = opts.identity;
    this.getMeta = opts.getMeta;
    this.onBeat = opts.onBeat;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      const m = this.getMeta();
      this.counter += 1;
      const hb = signHeartbeat(this.identity, {
        networkId: m.networkId,
        domainId: m.domainId,
        epoch: m.epoch,
        counter: this.counter,
        sequence: m.sequence,
        stateRoot: m.stateRoot,
        ts: Date.now(),
      });
      this.onBeat(hb);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
