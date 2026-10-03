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
 *
 * v0.4.4 (UEP-B13): every machine has a registered Ed25519 key and every usage
 * report must be signed by it (no unsigned SIMULATED mode). Providers and
 * machines are registered with the provider's marketplace signature. Telemetry
 * carries `unitsDelivered`; the marketplace only releases an IoT order through
 * the normal settle() path when the delivered telemetry was verified and
 * reports the full contracted quantity. A shortfall goes to a dispute.
 *
 * v0.4.6 (UEP-D04/D05): a dispute timeout configured as RELEASE runs the same
 * guard and refunds the buyer when it fails; units executed per verified
 * telemetry are reported to the marketplace as consumed capacity.
 *
 * v0.5.0 (ADR 0002): time is the Marketplace's block height. `observedAt` is
 * the height at which the machine observed the measurement, and the telemetry
 * age window is the base window plus the fixed delay of the order's domain
 * profile (EARTH 0, MOON 1, MARS 602 heights). No clock is read here.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { encodeCanonicalCbor } from "./iot-m2m-codec.ts";
import { contentHash } from "./content-hash.ts";
import { tupleKey } from "../core/composite-key.ts";
import type { CategoryServiceAccess, DigitalServicesMarketplace, ServiceOrder } from "../marketplace/marketplace.ts";
import type { ActorAuth } from "../marketplace/identity.ts";
import type { TransitionClock } from "../core/height.ts";

/** Default telemetry age window, in heights (60 = 5 min at 5 s blocks). */
export const DEFAULT_TELEMETRY_MAX_AGE_HEIGHTS = 60;
/** Default tolerance for an observation height ahead of the Marketplace height (6 = 30 s). */
export const DEFAULT_TELEMETRY_MAX_FUTURE_SKEW_HEIGHTS = 6;

export const IOT_M2M_VERSION = "0.3" as const;
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
  /** SPKI DER hex of the machine's Ed25519 key (required since v0.4.4). Every usage report is signed by it. */
  publicKeyHex: string;
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
  /** v0.4.4: units of the contracted service the machine reports as delivered (decimal string). */
  unitsDelivered: string;
  /** Unique machine-scoped nonce. Replay of an already verified nonce is rejected. */
  nonce: string;
  /** Ed25519 signature by the machine key over the unsigned canonical telemetry envelope (required). */
  signature?: string;
};

export type IoTVerification = {
  ok: true;
  telemetryHash: string;
  verifiedAt: number;
  machineId: string;
  sequence: number;
  authentication: "ED25519";
  /** v0.4.4: verified units and whether they cover the contracted quantity. */
  unitsDelivered: bigint;
  fullyDelivered: boolean;
  /** Content hash of the delivered telemetry payload (bound to the marketplace order). */
  deliveryHash: string;
};

export type IoTSettlement = ReturnType<DigitalServicesMarketplace["settle"]> & {
  requestId: string;
  contractId: string;
  machineId: string;
};

export type IoTM2MConfig = {
  /**
   * @deprecated TEST-ONLY injected counter, in the Marketplace's time unit
   * (only allowed when the Marketplace uses the test-only legacy ms clock).
   * Default: the Marketplace height (`marketplace.clock()`).
   */
  now?: () => number;
  /** Base telemetry age window in heights (default 60); the order's domain delay is added. */
  telemetryMaxAgeHeights?: number;
  /** Legacy form of telemetryMaxAgeHeights in ms (converted, ceil). */
  telemetryMaxAgeMs?: number;
  /** Tolerance for an observation height ahead of the Marketplace height (default 6). */
  telemetryMaxFutureSkewHeights?: number;
  telemetryMaxFutureSkewMs?: number;
  /**
   * Optional extra gate for deactivation, evaluated after the marketplace
   * administrator's signature verifies (v0.4.4: a signature is always required).
   */
  adminAuthorizer?: (actorId: string) => boolean;
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

/** Machine terms bound into the provider's "iot-machine-register" signature. */
export function iotMachineTerms(input: { providerId: string; serviceType: string; model: string; endpointRef: string; publicKeyHex: string }): Record<string, unknown> {
  return { providerId: input.providerId, serviceType: input.serviceType, model: input.model, endpointRef: input.endpointRef, publicKeyHex: input.publicKeyHex };
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

/** Canonical bytes delivered to the marketplace for a telemetry report. */
export function iotTelemetryPayload(telemetry: IoTTelemetry): Buffer {
  return encodeCanonicalCbor({
    requestId: telemetry.requestId,
    contractId: telemetry.contractId,
    providerId: telemetry.providerId,
    machineId: telemetry.machineId,
    sequence: telemetry.sequence,
    observedAt: telemetry.observedAt,
    nonce: telemetry.nonce,
    measurements: telemetry.measurements,
    unitsDelivered: telemetry.unitsDelivered,
  });
}

/** Delivery hash the provider signs when delivering a telemetry report ("deliver" action). */
export function iotTelemetryDeliveryHash(telemetry: IoTTelemetry): string {
  return contentHash(iotTelemetryPayload(telemetry));
}

const telemetryPayload = iotTelemetryPayload;

export class IoTM2MService {
  readonly version = IOT_M2M_VERSION;
  private readonly now: () => number;
  /** Base telemetry age window and future skew, in Marketplace ticks (heights; ms with the test-only clock). */
  readonly telemetryMaxAge: number;
  readonly telemetryMaxFutureSkew: number;
  private readonly adminAuthorizer?: (actorId: string) => boolean;
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
  private readonly requestByOrder = new Map<string, string>();
  /** Category capability: read IoT orders only (no access to other marketplace orders). */
  private readonly orders: CategoryServiceAccess;

  readonly marketplace: DigitalServicesMarketplace;

  constructor(marketplace: DigitalServicesMarketplace, config: IoTM2MConfig = {}) {
    this.marketplace = marketplace;
    const clock: TransitionClock = marketplace.transitionClock;
    if (config.now !== undefined && clock.unit !== "legacy-ms") throw new Error("CLOCK_CONFIG_CONFLICT: the IoT service uses the Marketplace height; `now` is only allowed with the test-only legacy clock");
    this.now = config.now ?? (() => marketplace.clock());
    this.telemetryMaxAge = clock.window("telemetryMaxAge", config.telemetryMaxAgeHeights, config.telemetryMaxAgeMs, DEFAULT_TELEMETRY_MAX_AGE_HEIGHTS);
    this.telemetryMaxFutureSkew = clock.window("telemetryMaxFutureSkew", config.telemetryMaxFutureSkewHeights, config.telemetryMaxFutureSkewMs, DEFAULT_TELEMETRY_MAX_FUTURE_SKEW_HEIGHTS);
    if (!Number.isSafeInteger(this.telemetryMaxAge) || this.telemetryMaxAge <= 0 || !Number.isSafeInteger(this.telemetryMaxFutureSkew) || this.telemetryMaxFutureSkew < 0) throw new Error("IOT_TELEMETRY_WINDOW_INVALID");
    this.adminAuthorizer = config.adminAuthorizer;
    // Every release of an IoT order (settle, dispute withdrawal, RELEASE timeout)
    // requires verified, complete telemetry; verified units count as consumed capacity.
    this.orders = marketplace.attachCategoryService(IOT_M2M_CATEGORY, {
      settlementGuard: (order) => this.assertSettleable(order),
      consumedUnits: (order) => this.verifiedUnitsOf(order),
    });
  }

  /** Register an IoT provider (v0.4.4: a registered marketplace identity, provider-signed). */
  registerProvider(input: { providerId: string; displayName: string }, auth?: ActorAuth): IoTProvider {
    if (!input.providerId || !input.displayName) throw new Error("IOT_PROVIDER_METADATA_REQUIRED");
    if (!this.marketplace.isIdentityRegistered(input.providerId)) throw new Error("IDENTITY_NOT_REGISTERED");
    if (this.marketplace.authenticateActor(auth, "iot-provider-register", input.providerId, { displayName: input.displayName }) !== input.providerId) throw new Error("IOT_PROVIDER_NOT_AUTHORIZED");
    if (this.providers.has(input.providerId)) throw new Error("IOT_PROVIDER_ALREADY_REGISTERED");
    const provider: IoTProvider = { providerId: input.providerId, displayName: input.displayName, registeredAt: this.now(), active: true };
    this.providers.set(provider.providerId, provider);
    return { ...provider };
  }

  /** Deactivate a provider (marketplace administrator signature, "iot-provider-deactivate"). */
  deactivateProvider(providerId: string, auth?: ActorAuth): void {
    this.assertAdmin(auth, "iot-provider-deactivate", providerId);
    const provider = this.provider(providerId);
    provider.active = false;
  }

  /**
   * Register a machine (v0.4.4): `publicKeyHex` (Ed25519) is required and the
   * provider signs "iot-machine-register" over the machine's key and metadata.
   */
  registerMachine(input: Omit<IoTMachine, "registeredAt" | "active">, auth?: ActorAuth): IoTMachine {
    const provider = this.provider(input.providerId);
    if (!provider.active) throw new Error("IOT_PROVIDER_INACTIVE");
    if (!input.machineId || !input.serviceType || !input.model || !input.endpointRef) throw new Error("IOT_MACHINE_METADATA_REQUIRED");
    if (!input.publicKeyHex) throw new Error("IOT_MACHINE_PUBLIC_KEY_REQUIRED");
    try {
      const key = createPublicKey({ key: Buffer.from(input.publicKeyHex, "hex"), type: "spki", format: "der" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error("not-ed25519");
    } catch {
      throw new Error("IOT_MACHINE_PUBLIC_KEY_INVALID");
    }
    if (this.marketplace.authenticateActor(auth, "iot-machine-register", input.machineId, iotMachineTerms(input)) !== input.providerId) throw new Error("IOT_PROVIDER_NOT_AUTHORIZED");
    if (this.machines.has(input.machineId)) throw new Error("IOT_MACHINE_ALREADY_REGISTERED");
    const machine: IoTMachine = { machineId: input.machineId, providerId: input.providerId, serviceType: input.serviceType, model: input.model, endpointRef: input.endpointRef, publicKeyHex: input.publicKeyHex, registeredAt: this.now(), active: true };
    this.machines.set(machine.machineId, machine);
    return { ...machine };
  }

  /** Deactivate a machine: marketplace administrator or the machine's own provider ("iot-machine-deactivate"). */
  deactivateMachine(machineId: string, auth?: ActorAuth): void {
    const machine = this.machine(machineId);
    let actor: string | undefined;
    try { actor = this.marketplace.authenticateActor(auth, "iot-machine-deactivate", machineId); } catch { throw new Error("IOT_ADMIN_AUTH_REQUIRED"); }
    if (actor !== machine.providerId) this.assertAdmin(auth, "iot-machine-deactivate", machineId);
    machine.active = false;
  }

  /**
   * Request an IoT service. The buyer must be a registered marketplace identity and
   * `authorization` must be the buyer's signReservation() signature over
   * { listingId, buyerId, quantity, idempotencyKey }. The reservation deposit is
   * locked from the buyer's marketplace balance.
   */
  requestService(input: { requestId?: string; idempotencyKey: string; authorization: string; buyerId: string; listingId: string; machineId: string; quantity: bigint }): IoTServiceRequest & { order: ServiceOrder; contract: IoTContract } {
    const machine = this.machine(input.machineId);
    if (!machine.active) throw new Error("IOT_MACHINE_INACTIVE");
    const listing = this.marketplace.getListing(input.listingId);
    if (listing.category !== IOT_M2M_CATEGORY) throw new Error("LISTING_NOT_IOT_M2M");
    if (listing.providerId !== machine.providerId) throw new Error("MACHINE_PROVIDER_MISMATCH");
    const provider = this.provider(machine.providerId);
    if (!provider.active) throw new Error("IOT_PROVIDER_INACTIVE");
    if (!input.buyerId) throw new Error("IOT_BUYER_REQUIRED");
    if (input.quantity <= 0n) throw new Error("IOT_INVALID_QUANTITY");
    if (!input.idempotencyKey) throw new Error("IOT_IDEMPOTENCY_KEY_REQUIRED");

    const reservation = { listingId: input.listingId, buyerId: input.buyerId, quantity: input.quantity, idempotencyKey: input.idempotencyKey, signature: input.authorization };
    // Fail closed before touching any state: registered buyer + valid signature.
    this.marketplace.assertReservationAuthorized(reservation);
    const idemKey = tupleKey(input.buyerId, input.idempotencyKey);
    const previous = this.requestIdempotency.get(idemKey);
    if (previous) return this.requestBundle(previous);

    const requestId = input.requestId ?? id("iotreq", `${input.buyerId}|${input.listingId}|${input.machineId}|${input.quantity}|${this.now()}`);
    if (this.requests.has(requestId)) throw new Error("IOT_REQUEST_ALREADY_EXISTS");
    const order = this.marketplace.reserve(reservation);
    this.requestByOrder.set(order.orderId, requestId);
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
    this.requestIdempotency.set(idemKey, requestId);
    return { ...request, order, contract };
  }

  /** Amount the buyer funds at hold() (gross + gas - locked deposit); sign "fund" over it. */
  holdAmount(requestId: string): bigint {
    const order = this.orders.readOrder(this.contractForRequest(requestId).orderId);
    return order.grossAmount + (order.gasFee ?? 0n) - order.reservationDeposit;
  }

  /** Buyer funds the escrow ("fund" signature by the buyer over { amount: holdAmount() }). */
  hold(requestId: string, auth?: ActorAuth): ServiceOrder {
    const request = this.request(requestId);
    const contract = this.contractForRequest(request.requestId);
    // The reservation deposit already locked at request time counts toward the payment.
    return this.marketplace.fundOrder(contract.orderId, this.holdAmount(requestId), auth, `iot-hold:${request.buyerId}:${requestId}`);
  }

  /**
   * Simulated execution: the machine produces a usage report signed with its
   * registered key (`signer` is the machine's private key; required).
   * `unitsDelivered` defaults to the contracted quantity.
   */
  simulateExecution(requestId: string, measurements: Record<string, string>, observedAt = this.now(), signer?: KeyObject, unitsDelivered?: bigint): IoTTelemetry {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const machine = this.machine(request.machineId);
    if (!machine.active) throw new Error("IOT_MACHINE_INACTIVE");
    const order = this.orders.readOrder(contract.orderId);
    if (order.status !== "HELD") throw new Error("IOT_EXECUTION_REQUIRES_HOLD");
    if (!signer || typeof signer !== "object") throw new Error("IOT_SIGNED_TELEMETRY_REQUIRED");
    const units = unitsDelivered ?? contract.quantity;
    if (typeof units !== "bigint" || units < 0n || units > contract.quantity) throw new Error("IOT_TELEMETRY_UNITS_INVALID");
    const generatedSequence = this.telemetrySequences.get(machine.machineId) ?? 0;
    const observedSequence = [...this.telemetry.values()]
      .filter((t) => t.machineId === machine.machineId)
      .reduce((max, t) => Math.max(max, t.sequence), 0);
    const sequence = Math.max(generatedSequence, observedSequence) + 1;
    const nonce = hash({ machineId: machine.machineId, requestId, sequence, observedAt }).slice(0, 32);
    const telemetryId = id("telemetry", { requestId, contractId: contract.contractId, machineId: machine.machineId, sequence, measurements, observedAt, nonce, unitsDelivered: units.toString() });
    if (this.telemetry.has(telemetryId)) throw new Error("IOT_TELEMETRY_REPLAY");
    const unsigned: IoTTelemetry = { telemetryId, requestId, contractId: contract.contractId, providerId: contract.providerId, machineId: machine.machineId, sequence, observedAt, measurements: { ...measurements }, unitsDelivered: units.toString(), nonce };
    const signature = signIoTTelemetry(unsigned, signer);
    if (!verifyIoTTelemetrySignature({ ...unsigned, signature }, machine.publicKeyHex)) throw new Error("IOT_TELEMETRY_SIGNATURE_INVALID");
    const row: IoTTelemetry = { ...unsigned, signature };
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
    if (!verifyIoTTelemetrySignature(telemetry, machine.publicKeyHex)) {
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

  /** Provider delivers a signed usage report ("deliver" signature over { deliveryHash: iotTelemetryDeliveryHash(t) }). */
  deliverTelemetry(requestId: string, telemetry: IoTTelemetry, providerAuth?: ActorAuth): ServiceOrder {
    if (!this.telemetry.has(telemetry.telemetryId)) this.ingestTelemetry(requestId, telemetry);
    this.assertTelemetryBinding(requestId, telemetry);
    const bytes = telemetryPayload(telemetry);
    return this.marketplace.deliverWithExpectedHash(
      this.contractForRequest(requestId).orderId,
      providerAuth,
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
    if (this.verifiedNonces.has(tupleKey(machine.machineId, telemetry.nonce))) throw new Error("IOT_TELEMETRY_NONCE_REPLAY");
    const lastObserved = this.telemetry.get(telemetry.telemetryId);
    if (!lastObserved) throw new Error("IOT_TELEMETRY_NOT_REGISTERED");
    if (stableJson(lastObserved) !== stableJson(telemetry)) throw new Error("IOT_TELEMETRY_TAMPERED");
    // v0.5.0 (ADR 0002): heights; the window includes the fixed delay of the order's domain profile.
    const order = this.orders.readOrder(contract.orderId);
    if (typeof telemetry.observedAt !== "number" || !Number.isFinite(telemetry.observedAt)) throw new Error("IOT_TELEMETRY_OBSERVED_AT_INVALID");
    if (this.now() - telemetry.observedAt > this.telemetryMaxAgeFor(order)) throw new Error("IOT_TELEMETRY_STALE");
    if (telemetry.observedAt > this.now() + this.telemetryMaxFutureSkew) throw new Error("IOT_TELEMETRY_FUTURE_TIMESTAMP");
    if (!verifyIoTTelemetrySignature(telemetry, machine.publicKeyHex)) throw new Error("IOT_TELEMETRY_SIGNATURE_INVALID");
    if (typeof telemetry.unitsDelivered !== "string" || !/^[0-9]+$/.test(telemetry.unitsDelivered)) throw new Error("IOT_TELEMETRY_UNITS_INVALID");
    const unitsDelivered = BigInt(telemetry.unitsDelivered);
    if (unitsDelivered > contract.quantity) throw new Error("IOT_TELEMETRY_UNITS_INVALID");
    // Only the report actually delivered to the marketplace order can be verified.
    const deliveryHash = iotTelemetryDeliveryHash(telemetry);
    if (order.deliveryHash !== deliveryHash) throw new Error("IOT_TELEMETRY_NOT_DELIVERED");
    const verification: IoTVerification = { ok: true, telemetryHash: hash(telemetry), verifiedAt: this.now(), machineId: machine.machineId, sequence: telemetry.sequence, authentication: "ED25519", unitsDelivered, fullyDelivered: unitsDelivered === contract.quantity, deliveryHash };
    this.verifiedMachineSequences.set(machine.machineId, telemetry.sequence);
    this.verifiedNonces.set(tupleKey(machine.machineId, telemetry.nonce), this.now());
    this.verified.set(requestId, verification);
    return verification;
  }

  /** v0.5.0: telemetry age window of one order (base + the order's domain delay), in Marketplace ticks. */
  telemetryMaxAgeFor(order: Pick<ServiceOrder, "windows">): number {
    return this.telemetryMaxAge + (order.windows?.domainDelay ?? 0);
  }

  /** Status of a request for a party or the admin (marketplace "read" authorization on the order). */
  serviceStatus(requestId: string, auth?: ActorAuth) {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    const order = this.marketplace.getOrder(contract.orderId, auth);
    const verification = this.verified.get(requestId);
    const nextAction = order.status === "ACCEPTED" ? "HOLD"
      : order.status === "HELD" ? "EXECUTE_AND_DELIVER"
      : order.status === "DELIVERED" && !verification ? "VERIFY_TELEMETRY"
      : order.status === "DELIVERED" && !verification.fullyDelivered ? "DISPUTE_USAGE_SHORTFALL"
      : order.status === "DELIVERED" ? "SETTLE"
      : order.status === "SETTLED" || order.status === "REFUNDED" ? "COMPLETE"
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
      /** For a usage shortfall: provider share an arbiter SPLIT would pay (verified units x unit price). */
      verifiedUsageAmount: verification ? verification.unitsDelivered * contract.unitPrice : null,
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

  /**
   * Settle through the marketplace ("settle" signature by the buyer, the
   * provider after the dispute window, or the arbiter). The marketplace's IoT
   * settlement guard requires verified telemetry covering the full quantity.
   */
  settle(requestId: string, auth?: ActorAuth): IoTSettlement {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    if (!this.verified.get(requestId)) throw new Error("IOT_VERIFICATION_REQUIRED");
    const settlement = this.marketplace.settle(contract.orderId, auth);
    return { ...settlement, requestId, contractId: contract.contractId, machineId: request.machineId };
  }

  /**
   * Settlement guard installed on the marketplace for IOT_M2M orders: the
   * delivered report of this order was verified and covers its full quantity.
   * v0.4.6 (UEP-D04): also gates a dispute timeout configured as RELEASE.
   */
  private assertSettleable(order: ServiceOrder): void {
    const requestId = this.requestByOrder.get(order.orderId);
    if (!requestId) throw new Error("IOT_VERIFIED_TELEMETRY_REQUIRED");
    const verification = this.verified.get(requestId);
    if (!verification) throw new Error("IOT_VERIFICATION_REQUIRED");
    if (verification.deliveryHash !== order.deliveryHash) throw new Error("IOT_TELEMETRY_NOT_DELIVERED");
    if (!verification.fullyDelivered || verification.unitsDelivered !== order.quantity) throw new Error("IOT_USAGE_SHORTFALL");
  }

  /**
   * v0.4.6 (UEP-D05): units of the order executed per verified telemetry of the
   * delivered report (0 without such a verification). The marketplace does not
   * return these units to the listing's capacity on a refund or split.
   */
  private verifiedUnitsOf(order: ServiceOrder): bigint {
    const requestId = this.requestByOrder.get(order.orderId);
    if (!requestId) return 0n;
    const verification = this.verified.get(requestId);
    if (!verification || verification.deliveryHash !== order.deliveryHash) return 0n;
    return verification.unitsDelivered;
  }

  private assertAdmin(auth: ActorAuth | undefined, action: "iot-provider-deactivate" | "iot-machine-deactivate", target: string): void {
    let actor: string;
    try { actor = this.marketplace.authenticateActor(auth, action, target); } catch { throw new Error("IOT_ADMIN_AUTH_REQUIRED"); }
    if (actor !== this.marketplace.adminIdentity) throw new Error("IOT_ADMIN_AUTH_REQUIRED");
    if (this.adminAuthorizer && !this.adminAuthorizer(actor)) throw new Error("IOT_ADMIN_AUTH_REQUIRED");
  }

  /** v0.4.4: request / contract / telemetry records require a "read" authorization on the order (party or admin). */
  getRequest(requestId: string, auth?: ActorAuth): IoTServiceRequest {
    this.marketplace.getOrder(this.contractForRequest(requestId).orderId, auth);
    return { ...this.request(requestId) };
  }
  getContract(contractId: string, auth?: ActorAuth): IoTContract {
    const contract = this.contract(contractId);
    this.marketplace.getOrder(contract.orderId, auth);
    return { ...contract };
  }
  getTelemetry(telemetryId: string, auth?: ActorAuth): IoTTelemetry {
    const t = this.telemetry.get(telemetryId);
    if (!t) throw new Error("IOT_TELEMETRY_NOT_FOUND");
    this.marketplace.getOrder(this.contractForRequest(t.requestId).orderId, auth);
    return { ...t, measurements: { ...t.measurements } };
  }

  /** Order id behind a request (needed to sign marketplace actions on it). */
  orderIdOf(requestId: string): string {
    return this.contractForRequest(requestId).orderId;
  }

  private requestBundle(requestId: string): IoTServiceRequest & { order: ServiceOrder; contract: IoTContract } {
    const request = this.request(requestId);
    const contract = this.contractForRequest(requestId);
    // Only reached after the buyer's reservation signature verified (idempotent replay).
    return { ...request, order: this.orders.readOrder(contract.orderId), contract };
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
