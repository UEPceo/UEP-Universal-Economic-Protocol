/**
 * Phase 2.7 IoT gateway. Outside the state machine: it validates a telemetry
 * report, queues it when the transport drops, and retries. The Marketplace
 * delivery key is the telemetry id, so a replay does not deliver twice.
 * Backoff is an attempt count, not a clock.
 */
import type { IoTTelemetry } from "./iot-m2m.ts";

export type GatewayResult = "sent" | "queued" | "duplicate";

export class IoTGateway {
  private readonly queued: IoTTelemetry[] = [];
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly send: (telemetry: IoTTelemetry) => void;
  private readonly maxAttempts: number;

  constructor(send: (telemetry: IoTTelemetry) => void, maxAttempts = 4) {
    this.send = send;
    this.maxAttempts = maxAttempts;
  }

  submit(telemetry: IoTTelemetry, transportUp = true): GatewayResult {
    assertTelemetrySchema(telemetry);
    if (this.seen.has(telemetry.telemetryId)) return "duplicate";
    if (!transportUp) {
      this.queued.push(telemetry);
      return "queued";
    }
    return this.trySend(telemetry);
  }

  flush(transportUp = true): number {
    if (!transportUp) return 0;
    let sent = 0;
    const pending = this.queued.splice(0);
    for (const telemetry of pending) {
      if (this.seen.has(telemetry.telemetryId)) continue;
      const result = this.trySend(telemetry);
      if (result === "sent") sent += 1;
    }
    return sent;
  }

  pending(): number {
    return this.queued.length;
  }

  private trySend(telemetry: IoTTelemetry): GatewayResult {
    const n = (this.attempts.get(telemetry.telemetryId) ?? 0) + 1;
    this.attempts.set(telemetry.telemetryId, n);
    try {
      this.send(telemetry);
      this.seen.add(telemetry.telemetryId);
      return "sent";
    } catch (error) {
      if (n >= this.maxAttempts) throw error;
      this.queued.push(telemetry);
      return "queued";
    }
  }
}

export function assertTelemetrySchema(telemetry: IoTTelemetry): void {
  if (!telemetry.telemetryId || !telemetry.requestId || !telemetry.machineId) throw new Error("IOT_GATEWAY_SCHEMA");
  if (!Number.isSafeInteger(telemetry.sequence) || telemetry.sequence <= 0) throw new Error("IOT_GATEWAY_SCHEMA");
  if (!/^[0-9a-f]{32}$/i.test(telemetry.nonce)) throw new Error("IOT_GATEWAY_SCHEMA");
  if (!/^[0-9]+$/.test(telemetry.unitsDelivered)) throw new Error("IOT_GATEWAY_SCHEMA");
}
