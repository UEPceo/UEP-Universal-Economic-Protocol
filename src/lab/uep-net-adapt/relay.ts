/**
 * Relay capability + selection (EXPERIMENTAL). No tokenomics.
 */

import type { ObservationConfidence, TransportType } from "./types.ts";
import { validateObservation, type NetworkObservation } from "./types.ts";

export type RelayCapability = {
  relayId: string;
  transport: TransportType;
  observation: NetworkObservation;
  trust: ObservationConfidence;
};

export type RelayPolicy =
  | "latency_sensitive"
  | "throughput_sensitive"
  | "reliability_sensitive"
  | "intermittent_ok";

export function scoreRelay(r: RelayCapability, policy: RelayPolicy): number {
  const o = r.observation;
  // Lower is better for ranking after inversion where needed
  switch (policy) {
    case "latency_sensitive":
      return -o.latencyMs + o.availability * 10;
    case "throughput_sensitive":
      return o.bandwidthMbps + o.availability * 50;
    case "reliability_sensitive":
      return o.availability * 1000 - o.packetLoss * 100 - o.latencyMs * 0.01;
    case "intermittent_ok":
      return o.availability * 100 + o.bandwidthMbps * 0.1 - o.latencyMs * 0.05;
  }
}

export function selectRelay(
  relays: RelayCapability[],
  policy: RelayPolicy,
): RelayCapability | null {
  const ok = relays.filter((r) => validateObservation(r.observation).ok);
  if (!ok.length) return null;
  const trustRank: Record<string, number> = {
    PROVEN: 6,
    ATTESTED: 5,
    MEASURED: 4,
    MEASURED_RECORDED: 3,
    SIMULATED: 2,
    SELF_REPORTED: 1,
  };
  ok.sort((a, b) => {
    const sa = scoreRelay(a, policy);
    const sb = scoreRelay(b, policy);
    if (sb !== sa) return sb - sa;
    return trustRank[b.trust] - trustRank[a.trust];
  });
  return ok[0]!;
}
