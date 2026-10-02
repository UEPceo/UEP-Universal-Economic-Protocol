/**
 * UEP IoT / Machine-to-Machine service layer v0.1
 *
 * This module adds machine-operated services on top of the existing
 * DigitalServicesMarketplace lifecycle. It does not create a parallel
 * payment system or bypass UEP settlement primitives.
 *
 * Lifecycle:
 * PROVIDER_REGISTERED -> MACHINE_REGISTERED -> SERVICE_REQUESTED
 * -> CONTRACTED -> HELD -> EXECUTED -> TELEMETRY_DELIVERED
 * -> VERIFIED -> SETTLED
 *
 * Execution is intentionally simulated. Telemetry is content-addressed and
 * bound to provider, machine, contract, request and monotonic sequence.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { encodeCanonicalCbor } from "./iot-m2m-codec.ts";
import type { DigitalServicesMarketplace, ServiceOrder } from "../marketplace/marketplace.ts";

export const IOT_M2M_VERSION = "0.2" as const;
export const IOT_M2M_CATEGORY = "IOT_M2M" as const;

export type IoTProvider = {
  providerId: string;
  displayName: string;
  registeredAt: number;
  active: boolean;
};

export type IoTMachine = {
  machineId: string;
  providerId: string;
  serviceType: string;
  model: string;
  endpointRef: string;
  /** SPKI DER hex. Presence upgrades the machine from simulation to signed telemetry. */
  publicKeyHex?: string;
  registeredAt: number;
  active: boolean;
};

export type IoTServiceRequest = {
  requestId: string;
  buyerId: string;
  listingId: string;
  providerId: string;
  machineId: string;
  quantity: bigint;
  createdAt: number;
};

export type IoTContract = {
  contractId: string;
  requestId: string;
  orderId: string;
  providerId: string;
  buyerId: string;
  machineId: string;
  serviceType: string;
  asset: string;
  quantity: bigint;
  unitPrice: bigint;
  grossAmount: bigint;
  createdAt: number;
};

export type IoTTelemetry = {
  telemetryId: string;
  requestId: string;
  contractId: string;
  providerId: string;
  machineId: string;
  sequence: number;
  observedAt: number;
  measurements: Readonly<Record<string, string>>;
  /** Unique machine-scoped nonce. Replay of an already verified nonce is rejected. */
  nonce: string;
  /** Ed25519 signature over the unsigned canonical telemetry envelope. */
  signature?: string;
};

export type IoTVerification = {
  ok: true;
  telemetryHash: string;
  verifiedAt: number;
  machineId: string;
  sequence: number;
  authentication: "ED25519" | "SIMULATED";
};

export type IoTSettlement = ReturnType<DigitalServicesMarketplace["settle"]> & {
  requestId: string;
  contractId: string;
  machineId: string;
};

export type IoTM2MConfig = {
  now?: () => number;
  telemetryMaxAgeMs?: number;
  telemetryMaxFutureSkewMs?: number;
};

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return `${nested}n`;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return nested;
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function id(prefix: string, value: unknown): string {
  return `${prefix}_${hash(value).slice(0, 24)}`;
}

export type IoTMachineIdentity = {
  publicKeyHex: string;
  privateKey: KeyObject;
};

export function createIoTMachineIdentity(): IoTMachineIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
  };
}

function unsignedTelemetry(telemetry: IoTTelemetry): Omit<IoTTelemetry, "signature"> {
  const { signature: _signature, ...unsigned } = telemetry;
  return unsigned;
}

export function signIoTTelemetry(telemetry: IoTTelemetry, privateKey: KeyObject): string {
  return cryptoSign(null, encodeCanonicalCbor(unsignedTelemetry(telemetry)), privateKey).toString("hex");
}

function verifyIoTTelemetrySignature(telemetry: IoTTelemetry, publicKeyHex: string): boolean {
  if (!telemetry.signature) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyHex, "hex"), type: "spki", format: "der" });
    return cryptoVerify(null, encodeCanonicalCbor(unsignedTelemetry(telemetry)), publicKey, Buffer.from(telemetry.signature, "hex"));
  } catch {
    return false;
  }
}

function telemetryPayload(telemetry: IoTTelemetry): Buffer {
  return encodeCanonicalCbor({
    requestId: telemetry.requestId,
    contractId: telemetry.contractId,
    providerId: telemetry.providerId,
    machineId: telemetry.machineId,
    sequence: telemetry.sequence,
    observedAt: telemetry.observedAt,
    nonce: telemetry.nonce,
    measurements: telemetry.measurements,
  });
}

export class IoTM2MService {
  readonly version = IOT_M2M_VERSION;
  private readonly now: () => number;
  private readonly telemetryMaxAgeMs: number;
  private readonly telemetryMaxFutureSkewMs: number;
  private readonly providers = new Map<string, IoTProvider>();
  private readonly machines = new Map<string, IoTMachine>();
  private readonly requests = new Map<string, IoTServiceRequest>();
  private readonly contracts = new Map<string, IoTContract>();
  private readonly telemetry = new Map<string, IoTTelemetry>();
  private readonly verified = new Map<string, IoTVerification>();
  private readonly requestIdempotency = new Map<string, string>();
  private readonly telemetrySequences = new Map<string, number>();
  private readonly verifiedMachineSequences = new Map<string, number>();
  private readonly verifiedNonces = new Map<string, number>();

  readonly marketplace: DigitalServicesMarketplace;

  constructor(marketplace: DigitalServicesMarketplace, config: IoTM2MConfig = {}) {
    this.marketplace = marketplace;
    this.now = config.now ?? (() => Date.now());
    this.telemetryMaxAgeMs = config.telemetryMaxAgeMs ?? 5 * 60 * 1000;
    this.telemetryMaxFutureSkewMs = config.telemetryMaxFutureSkewMs ?? 30_000;
  }

  registerProvider(input: { providerId: string; displayName: string }): IoTProvider {
    if (!input.providerId || !input.displayName) throw new Error("IOT_PROVIDER_METADATA_REQUIRED");
    if (this.providers.has(input.providerId)) throw new Error("IOT_PROVIDER_ALREADY_REGISTERED");
    const provider: IoTProvider = { providerId: input.providerId, displayName: input.displayName, registeredAt: this.now(), active: true };
    this.providers.set(provider.providerId, provider);
    return { ...provider };
  }

  deactivateProvider(providerId: string): void {
    const provider = this.provider(providerId);
    provider.active = false;
  }

  registerMachine(input: Omit<IoTMachine, "registeredAt" | "active">): IoTMachine {
    const provider = this.provider(input.providerId);
    if (!provider.active) throw new Error("IOT_PROVIDER_INACTIVE");
    if (!input.machineId || !input.serviceType || !input.model || !input.endpointRef) throw new Error("IOT_MACHINE_METADATA_REQUIRED");
    if (input.publicKeyHex) {
      try {
        const key = createPublicKey({ key: Buffer.from(input.publicKeyHex, "hex"), type: "spki", format: "der" });
        if (key.asymmetricKeyType !== "ed25519") throw new Error("not-ed25519");
      } catch {
        throw new Error("IOT_MACHINE_PUBLIC_KEY_INVALID");
      }
    }
    if (this.machines.has(input.machineId)) throw new Error("IOT_MACHINE_ALREADY_REGISTERED");
    const machine: IoTMachine = { ...input, registeredAt: this.now(), active: true };
    this.machines.set(machine.machineId, machine);
    return { ...machine };
  }

  deactivateMachine(machineId: string): void {
    const machine = this.machine(machineId);
    machine.active = false;
  }

  requestService(input: { requestId?: string; idempotencyKey?: string; buyerId: string; listingId: string; machineId: string; quantity: bigint }): IoTServiceRequest & { order: ServiceOrder; contract: IoTContract } {
    const machine = this.machine(input.machineId);
    if (!machine.active) throw new Error("IOT_MACHINE_INACTIVE");
    const listing = this.marketplace.getListing(input.listingId);
    if (listing.category !== IOT_M2M_CATEGORY) throw new Error("LISTING_NOT_IOT_M2M");
    if (listing.providerId !== machine.providerId) throw new Error("MACHINE_PROVIDER_MISMATCH");
    const provider = this.provider(machine.providerId);
    if (!provider.active) throw new Error("IOT_PROVIDER_INACTIVE");
    if (!input.buyerId) throw new Error("IOT_BUYER_REQUIRED");
    if (input.quantity <= 0n) throw new Error("IOT_INVALID_QUANTITY");

    const idemKey = input.idempotencyKey ? `${input.buyerId}:${input.idempotencyKey}` : undefined;
    if (idemKey) {
      const previous = this.requestIdempotency.get(idemKey);
      if (previous) return this.requestBundle(previous);
    }

    const requestId = input.requestId ?? id("iotreq", `${input.buyerId}|${input.listingId}|${input.machineId}|${input.quantity}|${this.now()}`);
    if (this.requests.has(requestId)) throw new Error("IOT_REQUEST_ALREADY_EXISTS");
    const order = this.marketplace.acceptOrder({
      listingId: input.listingId,
      buyerId: input.buyerId,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
    });
    const request: IoTServiceRequest = {
      requestId,
      buyerId: input.buyerId,
      listingId: input.listingId,
      providerId: machine.providerId,
      machineId: machine.machineId,
      quantity: input.quantity,
      createdAt: this.now(),
    };
    const contract: IoTContract = {
      contractId: id("iotctr", requestId),
      requestId,
      orderId: order.orderId,
      providerId: machine.providerId,
      buyerId: input.buyerId,
      machineId: machine.machineId,
      serviceType: machine.serviceType,
      asset: order.asset,
      quantity: order.quantity,
      unitPrice: listing.unitPrice,
      grossAmount: order.grossAmount,
      createdAt: this.now(),
    };
    this.requests.set(requestId, request);
    this.contracts.set(contract.contractId, contract);
    if (idemKey) this.requestIdempotency.set(idemKey, requestId);
    return { ...request, order, contract };
  }

  hold(requestId: string): ServiceOrder {
    const request = this.request(requestId);
    const contract = this.contractForRequest(request.requestId);
    return this.marketplace.fundOrder(contract.orderId, contract.grossAmount);
  }

  simulateExecution(requestId: string, measurements: Record<string, string>, observedAt = this.now(), signer?: KeyObject | string): IoTTelemetry {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const machine = this.machine(request.machineId);
    if (!machine.active) throw new Error("IOT_MACHINE_INACTIVE");
    const order = this.marketplace.getOrder(contract.orderId, contract.providerId);
    if (order.status !== "HELD") throw new Error("IOT_EXECUTION_REQUIRES_HOLD");
    const generatedSequence = this.telemetrySequences.get(machine.machineId) ?? 0;
    const observedSequence = [...this.telemetry.values()]
      .filter((t) => t.machineId === machine.machineId)
      .reduce((max, t) => Math.max(max, t.sequence), 0);
    const sequence = Math.max(generatedSequence, observedSequence) + 1;
    const nonce = hash({ machineId: machine.machineId, requestId, sequence, observedAt }).slice(0, 32);
    const telemetryId = id("telemetry", { requestId, contractId: contract.contractId, machineId: machine.machineId, sequence, measurements, observedAt, nonce });
    if (this.telemetry.has(telemetryId)) throw new Error("IOT_TELEMETRY_REPLAY");
    let signature: string | undefined;
    if (machine.publicKeyHex) {
      if (!signer || typeof signer === "string") throw new Error("IOT_SIGNED_TELEMETRY_REQUIRED");
      signature = signIoTTelemetry({ telemetryId, requestId, contractId: contract.contractId, providerId: contract.providerId, machineId: machine.machineId, sequence, observedAt, measurements: { ...measurements }, nonce }, signer);
    } else if (typeof signer === "string") {
      signature = signer;
    }
    const row: IoTTelemetry = { telemetryId, requestId, contractId: contract.contractId, providerId: contract.providerId, machineId: machine.machineId, sequence, observedAt, measurements: { ...measurements }, nonce, ...(signature ? { signature } : {}) };
    this.telemetry.set(telemetryId, row);
    this.telemetrySequences.set(machine.machineId, sequence);
    return { ...row, measurements: { ...row.measurements } };
  }

  ingestTelemetry(requestId: string, telemetry: IoTTelemetry): IoTTelemetry {
    this.assertTelemetryEnvelope(requestId, telemetry);
    const machine = this.machine(telemetry.machineId);
    const existing = this.telemetry.get(telemetry.telemetryId);
    if (existing) {
      if (stableJson(existing) !== stableJson(telemetry)) throw new Error("IOT_TELEMETRY_TAMPERED");
      throw new Error("IOT_TELEMETRY_REPLAY");
    }
    if (machine.publicKeyHex && !verifyIoTTelemetrySignature(telemetry, machine.publicKeyHex)) {
      throw new Error("IOT_TELEMETRY_SIGNATURE_INVALID");
    }
    const verifiedSequence = this.verifiedMachineSequences.get(machine.machineId) ?? 0;
    if (telemetry.sequence <= verifiedSequence) throw new Error("IOT_TELEMETRY_SEQUENCE_REPLAY");
    if ([...this.telemetry.values()].some((t) => t.machineId === machine.machineId && t.nonce === telemetry.nonce)) {
      throw new Error("IOT_TELEMETRY_NONCE_REPLAY");
    }
    this.telemetry.set(telemetry.telemetryId, { ...telemetry, measurements: { ...telemetry.measurements } });
    return { ...telemetry, measurements: { ...telemetry.measurements } };
  }

  deliverTelemetry(requestId: string, telemetry: IoTTelemetry): ServiceOrder {
    if (!this.telemetry.has(telemetry.telemetryId)) this.ingestTelemetry(requestId, telemetry);
    this.assertTelemetryBinding(requestId, telemetry);
    const bytes = telemetryPayload(telemetry);
    return this.marketplace.deliverWithExpectedHash(
      this.contractForRequest(requestId).orderId,
      telemetry.providerId,
      bytes,
      createHash("sha256").update(bytes).digest("hex"),
      `iot-delivery:${telemetry.telemetryId}`,
    );
  }

  verifyTelemetry(requestId: string, telemetry: IoTTelemetry): IoTVerification {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const machine = this.machine(request.machineId);
    this.assertTelemetryBinding(requestId, telemetry);
    if (!Number.isSafeInteger(telemetry.sequence) || telemetry.sequence <= 0) throw new Error("IOT_TELEMETRY_SEQUENCE_INVALID");
    if (!telemetry.nonce || !/^[0-9a-f]{32}$/i.test(telemetry.nonce)) throw new Error("IOT_TELEMETRY_NONCE_INVALID");
    const last = this.verified.get(requestId);
    if (last && telemetry.sequence <= last.sequence) throw new Error("IOT_TELEMETRY_SEQUENCE_REPLAY");
    const machineLast = this.verifiedMachineSequences.get(machine.machineId) ?? 0;
    if (telemetry.sequence <= machineLast) throw new Error("IOT_TELEMETRY_SEQUENCE_REPLAY");
    if (this.verifiedNonces.has(`${machine.machineId}:${telemetry.nonce}`)) throw new Error("IOT_TELEMETRY_NONCE_REPLAY");
    const lastObserved = this.telemetry.get(telemetry.telemetryId);
    if (!lastObserved) throw new Error("IOT_TELEMETRY_NOT_REGISTERED");
    if (stableJson(lastObserved) !== stableJson(telemetry)) throw new Error("IOT_TELEMETRY_TAMPERED");
    if (this.now() - telemetry.observedAt > this.telemetryMaxAgeMs) throw new Error("IOT_TELEMETRY_STALE");
    if (telemetry.observedAt > this.now() + this.telemetryMaxFutureSkewMs) throw new Error("IOT_TELEMETRY_FUTURE_TIMESTAMP");
    const authentication = machine.publicKeyHex
      ? (verifyIoTTelemetrySignature(telemetry, machine.publicKeyHex) ? "ED25519" : "SIMULATED")
      : "SIMULATED";
    if (machine.publicKeyHex && authentication !== "ED25519") throw new Error("IOT_TELEMETRY_SIGNATURE_INVALID");
    const verification: IoTVerification = { ok: true, telemetryHash: hash(telemetry), verifiedAt: this.now(), machineId: machine.machineId, sequence: telemetry.sequence, authentication };
    this.verifiedMachineSequences.set(machine.machineId, telemetry.sequence);
    this.verifiedNonces.set(`${machine.machineId}:${telemetry.nonce}`, this.now());
    this.verified.set(requestId, verification);
    return verification;
  }

  serviceStatus(requestId: string) {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const order = this.marketplace.getOrder(contract.orderId, contract.buyerId);
    const verification = this.verified.get(requestId);
    const nextAction = order.status === "ACCEPTED" ? "HOLD"
      : order.status === "HELD" ? "EXECUTE_AND_DELIVER"
      : order.status === "DELIVERED" && !verification ? "VERIFY_TELEMETRY"
      : order.status === "DELIVERED" ? "SETTLE"
      : order.status === "SETTLED" ? "COMPLETE"
      : order.status;
    return {
      requestId,
      machineId: request.machineId,
      orderId: order.orderId,
      status: order.status,
      grossAmount: order.grossAmount,
      marketplaceFeeEstimate: order.marketplaceFeeEstimate,
      providerNetEstimate: order.providerNetEstimate,
      verification: verification ? { ...verification } : null,
      nextAction,
    } as const;
  }

  private assertTelemetryEnvelope(requestId: string, telemetry: IoTTelemetry): void {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const machine = this.machine(request.machineId);
    if (telemetry.requestId !== request.requestId) throw new Error("IOT_TELEMETRY_REQUEST_MISMATCH");
    if (telemetry.contractId !== contract.contractId) throw new Error("IOT_TELEMETRY_CONTRACT_MISMATCH");
    if (telemetry.providerId !== contract.providerId) throw new Error("IOT_TELEMETRY_PROVIDER_MISMATCH");
    if (telemetry.machineId !== machine.machineId) throw new Error("IOT_TELEMETRY_MACHINE_MISMATCH");
    if (!Number.isSafeInteger(telemetry.sequence) || telemetry.sequence <= 0) throw new Error("IOT_TELEMETRY_SEQUENCE_INVALID");
    if (!telemetry.nonce || !/^[0-9a-f]{32}$/i.test(telemetry.nonce)) throw new Error("IOT_TELEMETRY_NONCE_INVALID");
  }

  private assertTelemetryBinding(requestId: string, telemetry: IoTTelemetry): void {
    this.assertTelemetryEnvelope(requestId, telemetry);
    const registered = this.telemetry.get(telemetry.telemetryId);
    if (!registered) throw new Error("IOT_TELEMETRY_NOT_REGISTERED");
    if (stableJson(registered) !== stableJson(telemetry)) throw new Error("IOT_TELEMETRY_TAMPERED");
  }

  settle(requestId: string): IoTSettlement {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const verification = this.verified.get(requestId);
    if (!verification) throw new Error("IOT_VERIFICATION_REQUIRED");
    const settlement = this.marketplace.settle(contract.orderId, contract.buyerId);
    return { ...settlement, requestId, contractId: contract.contractId, machineId: request.machineId };
  }

  getRequest(requestId: string): IoTServiceRequest { return { ...this.request(requestId) }; }
  getContract(contractId: string): IoTContract { return { ...this.contract(contractId) }; }
  getTelemetry(telemetryId: string): IoTTelemetry { const t = this.telemetry.get(telemetryId); if (!t) throw new Error("IOT_TELEMETRY_NOT_FOUND"); return { ...t, measurements: { ...t.measurements } }; }

  private requestBundle(requestId: string): IoTServiceRequest & { order: ServiceOrder; contract: IoTContract } {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    return { ...request, order: this.marketplace.getOrder(contract.orderId, contract.buyerId), contract };
  }

  private provider(providerId: string): IoTProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error("IOT_PROVIDER_NOT_REGISTERED");
    return provider;
  }

  private machine(machineId: string): IoTMachine {
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error("IOT_MACHINE_NOT_REGISTERED");
    return machine;
  }

  private request(requestId: string): IoTServiceRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("IOT_REQUEST_NOT_FOUND");
    return request;
  }

  private contract(contractId: string): IoTContract {
    const contract = this.contracts.get(contractId);
    if (!contract) throw new Error("IOT_CONTRACT_NOT_FOUND");
    return contract;
  }

  private contractForRequest(requestId: string): IoTContract {
    const contract = [...this.contracts.values()].find((c) => c.requestId === requestId);
    if (!contract) throw new Error("IOT_CONTRACT_NOT_FOUND");
    return contract;
  }
}
