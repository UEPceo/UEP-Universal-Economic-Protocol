# Service layer (mixed status) (`src/service`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) for `iot-m2m*`, `content-hash.ts`, `height-producer.ts`, `ledger-submit-queue.ts`, `ledger-worker-host.ts`, `ledger-worker.ts`; Experimental (lab) for the rest |
| Since | 0.4.0 (IoT), 0.5.0 (lab files) |
| Tests | npm run test:marketplace (IoT, HTTP authorization), npm run test:lab (service/API lab) |
| Depends on | Marketplace, core, testnet, oracle (optional gate); lab files also import src/lab |

## Files

| File | Status |
|---|---|
| `iot-m2m.ts`, `iot-m2m-codec.ts`, `iot-testkit.ts` | Implemented (testnet) |
| `content-hash.ts`, `height-producer.ts` | Implemented (testnet) |
| `ledger-submit-queue.ts`, `ledger-worker-host.ts`, `ledger-worker.ts` (v0.5.3) | Implemented (testnet) |
| `uep-http-api.ts`, `uep-service-api.ts`, `uep-service-backends.ts`, `uep-api-types.ts`, `capabilities.ts` | Experimental (lab); authorization tests run in `test:marketplace` |
| `groth16-spend-queue.ts` | Experimental (lab); imports lab consensus / ZK modules |
| `storage-provider.ts`, `memory-storage.ts`, `s3-adapter.ts`, `ipfs-adapter.ts`, `provider-model.ts`, `observability.ts` | Experimental (lab) |

## Notes

- v0.5.3 decision: the lab files were not moved out of this folder, because every moved path would need a shim; see `docs/MODULES.md` §12.
- IoT readings are signed by the device key only (no hardware attestation).

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
