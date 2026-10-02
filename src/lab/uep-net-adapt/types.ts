/**
 * UEP-NET-ADAPT types (EXPERIMENTAL) — 35.6.1 confidence refinement
 */

export type TransportType =
  | "fiber"
  | "5g"
  | "satellite"
  | "starlink"
  | "dtn"
  | "optical"
  | "intermittent"
  | "mock";

/** Confidence ladder — recorded telemetry is NOT live MEASURED */
export type ObservationConfidence =
  | "SELF_REPORTED"
  | "SIMULATED"
  | "MEASURED_RECORDED"
  | "MEASURED"
  | "ATTESTED"
  | "PROVEN";

export type ConnectivityStatus = "up" | "down" | "degraded" | "unknown";

export type NetworkObservation = {
  transport: TransportType;
  latencyMs: number;
  jitterMs: number;
  packetLoss: number;
  bandwidthMbps: number;
  availability: number;
  timestamp: number;
  source: string;
  confidence: ObservationConfidence;
  connectivityWindow?: { from: number; to: number };
};

export type NetworkAdapterInfo = {
  adapterId: string;
  transport: TransportType;
  status: ConnectivityStatus;
};

export interface NetworkAdapter {
  readonly info: NetworkAdapterInfo;
  send(to: string, payload: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }>;
  receive(): Promise<{ from: string; payload: Uint8Array } | null>;
  estimateLatencyMs(): number;
  estimateBandwidthMbps(): number;
  availability(): number;
  connectivityStatus(): ConnectivityStatus;
  observe(): NetworkObservation;
}

export function validateObservation(
  o: NetworkObservation,
): { ok: true } | { ok: false; reason: string } {
  if (o.latencyMs < 0 || !Number.isFinite(o.latencyMs)) {
    return { ok: false, reason: "NEGATIVE_OR_INVALID_LATENCY" };
  }
  if (o.bandwidthMbps < 0 || o.bandwidthMbps > 1_000_000) {
    return { ok: false, reason: "IMPOSSIBLE_BANDWIDTH" };
  }
  if (o.packetLoss < 0 || o.packetLoss > 1) {
    return { ok: false, reason: "INVALID_PACKET_LOSS" };
  }
  if (o.availability < 0 || o.availability > 1) {
    return { ok: false, reason: "INVALID_AVAILABILITY" };
  }
  if (o.timestamp > Date.now() + 60_000) {
    return { ok: false, reason: "FUTURE_TIMESTAMP" };
  }
  if (o.timestamp < Date.now() - 24 * 3600_000) {
    return { ok: false, reason: "STALE_TELEMETRY" };
  }
  return { ok: true };
}
