/**
 * Phase 2.1 in-process event bus. Not consensus. Ids are a hash of the
 * transition, so a replay of the same order status does not emit a second
 * event. No clock and no network.
 */
import { createHash } from "node:crypto";

export const EVENT_VERSION = 1;

export type ServiceEventType =
  | "order.accepted"
  | "order.held"
  | "order.delivered"
  | "order.disputed"
  | "order.settled"
  | "order.refunded"
  | "iot.telemetry"
  | "iot.settled";

export type ServiceEvent = {
  version: 1;
  id: string;
  type: ServiceEventType;
  subjectId: string;
  height: number;
  seq: number;
};

export function eventId(type: ServiceEventType, subjectId: string, height: number): string {
  return createHash("sha256").update(`${EVENT_VERSION}|${type}|${subjectId}|${height}`).digest("hex").slice(0, 32);
}

export class ServiceEventBus {
  private readonly events: ServiceEvent[] = [];
  private readonly seen = new Set<string>();
  private seq = 0;

  emit(type: ServiceEventType, subjectId: string, height: number): ServiceEvent | undefined {
    const id = eventId(type, subjectId, height);
    if (this.seen.has(id)) return undefined;
    this.seen.add(id);
    this.seq += 1;
    const event = { version: 1 as const, id, type, subjectId, height, seq: this.seq };
    this.events.push(event);
    if (this.events.length > 1024) {
      const dropped = this.events.shift();
      if (dropped) this.seen.delete(dropped.id);
    }
    return event;
  }

  list(after = 0, limit = 100): readonly ServiceEvent[] {
    const cap = Math.min(Math.max(limit, 1), 100);
    return this.events.filter((event) => event.seq > after).slice(0, cap);
  }
}
