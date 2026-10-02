# UEP-36.2 — API Service Layer

## Architecture
```
UEP CORE (consensus/state/ZK)  — untouched
UEP SERVICE LAYER — API, Storage, Observability
EXTERNAL ADAPTERS — S3, IPFS
```

## IMPLEMENTED
- UEP-API-001 types + ServiceApi facade
- StorageProvider + Memory / S3 / IPFS adapters
- contentHash integrity
- OpenTelemetry-style observability (non-critical)
- ProviderHealth, CapabilityDiscovery
- Idempotent putObject

## NOT IMPLEMENTED
- Compute / Relay / Oracle backends
- Payment backend
- Real AWS/IPFS network (adapters use injectable transports; LAB memory transports in tests)

## Invariants tested
External failure ≠ consensus failure; same contentHash across providers.
