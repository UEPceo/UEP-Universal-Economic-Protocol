/**
 * Agent nonce / sequence window (EXPERIMENTAL)
 *
 * - Opaque nonces: stored with optional TTL pruning
 * - Monotonic sequences: window watermark, no unbounded growth
 */

export type NonceRecord = { at: number; sequence?: number };

export class AgentNonceStore {
  private used = new Map<string, Map<string, NonceRecord>>();
  private lastSequence = new Map<string, number>();
  /** Max age for opaque nonces (ms). Default 24h. */
  readonly ttlMs: number;
  /** Keep sequences strictly above last - windowSize */
  readonly sequenceWindow: number;

  constructor(opts?: { ttlMs?: number; sequenceWindow?: number }) {
    this.ttlMs = opts?.ttlMs ?? 24 * 60 * 60 * 1000;
    this.sequenceWindow = opts?.sequenceWindow ?? 10_000;
  }

  checkAndConsume(
    agentId: string,
    nonce: string,
    sequence?: number,
  ): { ok: true } | { ok: false; reason: string } {
    if (!nonce || nonce.length < 8) return { ok: false, reason: "BAD_NONCE" };

    if (sequence !== undefined) {
      const last = this.lastSequence.get(agentId) ?? -1;
      if (sequence <= last) {
        return { ok: false, reason: "SEQUENCE_REPLAY" };
      }
      // Allow gaps but not regression; optional soft bound
      if (last >= 0 && sequence > last + this.sequenceWindow) {
        return { ok: false, reason: "SEQUENCE_GAP_TOO_LARGE" };
      }
      this.lastSequence.set(agentId, sequence);
    }

    let map = this.used.get(agentId);
    if (!map) {
      map = new Map();
      this.used.set(agentId, map);
    }
    if (map.has(nonce)) return { ok: false, reason: "NONCE_REPLAY" };
    map.set(nonce, { at: Date.now(), sequence });
    this.prune(agentId);
    return { ok: true };
  }

  /**
   * Drop expired opaque nonces; drop sequences below watermark.
   */
  prune(agentId?: string): void {
    const now = Date.now();
    const agents = agentId ? [agentId] : [...this.used.keys()];
    for (const id of agents) {
      const map = this.used.get(id);
      if (!map) continue;
      const last = this.lastSequence.get(id) ?? -1;
      for (const [n, rec] of [...map]) {
        const expired = now - rec.at > this.ttlMs;
        const belowWindow =
          rec.sequence !== undefined &&
          last >= 0 &&
          rec.sequence < last - this.sequenceWindow;
        if (expired || belowWindow) map.delete(n);
      }
      if (map.size === 0) this.used.delete(id);
    }
  }

  size(agentId: string): number {
    return this.used.get(agentId)?.size ?? 0;
  }

  lastSeq(agentId: string): number {
    return this.lastSequence.get(agentId) ?? -1;
  }
}
