# UEP IoT / M2M Service Layer v0.1

## Purpose

IoT/M2M adds machine-operated economic services without creating a parallel payment or settlement system. It reuses the existing Digital Services Marketplace lifecycle and Treasury accounting.

## Lifecycle

```text
Provider registration
        ↓
Machine registration
        ↓
Service listing (IOT_M2M)
        ↓
Service request
        ↓
Service contract
        ↓
HOLD
        ↓
Simulated machine execution
        ↓
Telemetry delivery
        ↓
Telemetry verification
        ↓
SETTLED
        ↓
Marketplace Treasury fee
```

## Implemented

- provider registration and activation state;
- machine/service identity bound to a registered provider;
- `IOT_M2M` Marketplace category;
- service requests with idempotency;
- deterministic service contracts bound to the request/order/machine;
- HOLD through the existing Marketplace funding primitive;
- simulated execution;
- content-addressed telemetry;
- telemetry binding to request, contract, provider and machine;
- monotonic telemetry sequence per machine;
- stale/future telemetry rejection;
- telemetry tamper detection;
- verification gate before settlement;
- settlement through existing Marketplace/Treasury code;
- existing 3% Marketplace fee, charged only at SETTLED;
- settlement replay safety and Treasury fee idempotency;
- Service API facade attachment and capability discovery.

## Explicit scope limitation

Execution is simulated in v0.1. `endpointRef` identifies the machine/service in the model but is not a network connection or physical-device attestation mechanism. A future hardware/gateway adapter must provide its own authenticated evidence before such evidence can be treated as stronger than this lab simulation.

## Security properties tested

Adversarial tests reject:

- duplicate provider registration;
- unknown machine IDs;
- machine/provider mismatch;
- non-IoT listings;
- execution before HOLD;
- telemetry from another request or contract;
- telemetry from another machine/provider;
- modified telemetry;
- stale telemetry;
- future-dated telemetry;
- repeated telemetry sequence verification;
- settlement before verification;
- repeated settlement / repeated Treasury fee.

## Economic integration

IoT/M2M does not mint a native token. The order is denominated in the Marketplace listing asset. The existing Marketplace Treasury charges 300 bps (3%) only when the order reaches `SETTLED`, with the existing 40/25/20/15 allocation. The provider receives the corresponding net amount in the Marketplace accounting model.

## Reproducible example

```bash
npm run test:iot
npm run test:marketplace
npm run example:iot
```
