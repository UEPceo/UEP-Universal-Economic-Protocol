# UEP BFT state-machine hardening — 0.5.76

## Scope

This change hardens the experimental BFT kernel only. It does not connect the kernel to `PeerNet`, add durable storage, implement timers/transport, or atomically apply blocks to the ledger. The legacy three-node harness remains unchanged.

## Protocol profile

The target is a Tendermint-style round-based BFT profile with `n >= 3f + 1` pinned validators and a `2f + 1` certificate quorum. This is a design direction, not a claim of exact Tendermint conformance or formal verification. An independent review against a pinned specification is still required.

## Changes

- Precommit creation now requires a valid prevote certificate for the exact height, round and block **and** a matching current lock previously registered through `observePrevoteCertificate()`.
- State restoration rejects duplicate lock keys, invalid lock-certificate metadata, and a lock whose block conflicts with a committed block at that height.
- State import validates into temporary maps before mutating active state, so a rejected import does not partially replace the current state.
- Added negative tests for precommit without a registered lock, duplicate locks, lock/commit conflicts and inconsistent lock metadata.
- Version advanced to `0.5.76`; economic fees and snapshot format are unchanged.

## Safety invariants

1. A certificate counts distinct validators only and requires `2f + 1` valid signatures bound to the same network/domain, height, round, phase and block.
2. A validator must not sign conflicting block IDs for one height/round/phase; anti-equivocation state must eventually be durable before a signature can be released in a production node.
3. Precommit is permitted only after the matching prevote certificate is verified and registered as the current lock. Production code must persist the lock durably before exposing the precommit signature.
4. Locks may not be downgraded; a conflicting proposal needs a valid higher-round certificate and round-change quorum preserving the highest certified lock.
5. Finality requires a verified precommit certificate; a prevote certificate alone is not finality.
6. Imported state must be fully validated before replacing active state.
7. `exportState()` is serialization only, not durable storage. `recordCommit()` records a certificate in this kernel but does not atomically apply a block to the ledger.

## Verification performed

- `npm run test:consensus-bft`: 16/16 passed on Node.js 22.16.0.
- `npm run test:consensus`: 60/60 passed on Node.js 22.16.0.
- `npm run check:version`: passed for 0.5.76.
- `npm run lint:determinism`: passed; 158 files scanned, 0 violations.
- `npm run check:snapshot-compat`: passed; snapshot format 10 and four migration steps from format 6.

## Remaining blockers

Durable atomic persistence/fsync before signatures, authenticated bounded peer transport, timers and retransmission, block content digest binding, certificate-backed recovery, atomic ledger application, process/network-fault testing and independent review remain mandatory. Do not claim production BFT or use this kernel for real value.
