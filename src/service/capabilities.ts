/**
 * Capability discovery — only advertise implemented services.
 */

import { UEP_API_VERSION } from "./uep-api-types.ts";

export type CapabilitiesDocument = {
  apiVersion: string;
  services: {
    storage: boolean;
    compute: boolean;
    relay: boolean;
    oracle: boolean;
    iotM2M: boolean;
  };
  storageBackends: string[];
  observability: {
    openTelemetryStyle: boolean;
    consensusCritical: false;
  };
  limits: {
    maxObjectBytes: number;
  };
  notes: string[];
};

export function getCapabilities(opts?: {
  storageBackends?: string[];
  compute?: boolean;
  relay?: boolean;
  oracle?: boolean;
  iotM2M?: boolean;
  spendSubmit?: boolean;
}): CapabilitiesDocument {
  return {
    apiVersion: UEP_API_VERSION,
    services: {
      storage: true,
      compute: opts?.compute === true,
      relay: opts?.relay === true,
      oracle: opts?.oracle === true,
      iotM2M: opts?.iotM2M === true,
    },
    storageBackends: opts?.storageBackends ?? ["memory", "s3", "ipfs"],
    observability: {
      openTelemetryStyle: true,
      consensusCritical: false,
    },
    limits: {
      maxObjectBytes: 16 * 1024 * 1024,
    },
    notes: [
      "External providers are never required for UEP consensus.",
      "Compute/Relay/Oracle/IoT-M2M are advertised only when the corresponding service is attached.",
      "A quote or a relayed envelope is not economic finality.",
      opts?.spendSubmit ? "Spend submit queues an intent. It does not finalize." : "Spend submit is not attached.",
    ],
  };
}
