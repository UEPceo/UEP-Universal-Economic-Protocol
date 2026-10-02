/**
 * Generic service provider model — UEP SERVICE LAYER.
 * Compute / Relay / Oracle: interfaces only (no backends in v36.2).
 */

export type ProviderHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type ProviderHealth = {
  status: ProviderHealthStatus;
  providerId: string;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
};

export type ServiceCapability =
  | "storage"
  | "compute"
  | "relay"
  | "oracle"
  | "iot-m2m";

export type ServiceProviderInfo = {
  providerId: string;
  displayName: string;
  capabilities: ServiceCapability[];
  version: string;
};

export interface ServiceProvider {
  readonly providerId: string;
  readonly info: ServiceProviderInfo;
  health(): Promise<ProviderHealth>;
}

/** Interface only — no implementation in v36.2 */
export interface ComputeProvider extends ServiceProvider {
  readonly capability: "compute";
}

/** Interface only — no implementation in v36.2 */
export interface RelayProvider extends ServiceProvider {
  readonly capability: "relay";
}

/** Interface only — no implementation in v36.2 */
export interface OracleProvider extends ServiceProvider {
  readonly capability: "oracle";
}
