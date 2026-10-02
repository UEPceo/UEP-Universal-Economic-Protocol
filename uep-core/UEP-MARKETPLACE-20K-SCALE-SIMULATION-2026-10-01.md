# UEP Digital Services Marketplace — 20,000 User Scale Simulation

Date: 2026-10-01

## Scope
Synthetic global workload representing 20,000 buyers distributed across EU, North America, LATAM, APAC, Africa and MENA. The simulation exercises listing publication, checkout, idempotent retries, funding, delivery, settlement, treasury accounting and a hot-stock contention scenario.

## Baseline result
- 20,000/20,000 orders accepted and settled.
- 20,000/20,000 idempotent checkout retries resolved to the original order.
- 20,000/20,000 deliveries accepted.
- 0 unexpected errors in the main flow.
- 100-unit hot listing: 100 accepted, 900 rejected, 0 oversell, 0 remaining capacity.
- EUR marketplace treasury after the 20,000 settlements: 60,000 minor units for the synthetic 100-unit orders at 3% fee.
- Main in-process execution: ~296 ms; contention test: ~7 ms in the local synthetic environment.

## Changes
1. **Abandoned reservation retention:** added explicit `reapExpiredReservations()` and automatic cleanup on listing reads/searches so expired capacity is returned instead of remaining reserved indefinitely.
2. **Idempotency namespace collision:** funding/delivery idempotency keys are now scoped by `orderId`, preventing the same external key from confusing independent orders.
3. **Large-catalog access:** marketplace search now supports bounded pagination and an index for category+asset queries; order listing supports bounded pages to avoid returning an unbounded collection to clients.

## Security note
The 20,000-user simulation is an application-layer/in-process synthetic test. It does not prove production database isolation, distributed locking, payment-provider behavior, or WAN latency. A production persistent adapter must preserve atomic conditional reservation / row locking semantics.
