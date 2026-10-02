# UEP-OBSERVABILITY-001

OpenTelemetry-**style** local telemetry (no hard dependency on OTEL packages).

## Rules
- Telemetry failure is swallowed; CORE continues.
- No private keys, secrets, or sensitive payloads in attributes.

## Metrics
uep_consensus_latency, uep_finality_latency, uep_transactions_total, uep_storage_*, …

## Exporters
NoopExporter, InMemoryExporter, FailingExporter (tests).
