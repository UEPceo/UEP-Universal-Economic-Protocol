# Bug Bounty and Independent Assessment — Phase 5

This document describes how to report security issues and how independent assessments are expected to work for the public testnet harness.

## Status

- Current version: `0.5.81` (Phase 5).
- This is a **testnet reference**. No real-world value. No production consensus.
- Fees: protocol 0.1 %, Marketplace 3 %. Ledger snapshot format 10.
- Latest tagged GitHub Release may lag `main`.

## Scope (in)

Reports are welcome for the reference path:

- Ledger integrity, nullifiers, commitments, state roots, fees, multi-asset isolation.
- Snapshot signing, restore, faucet/issuer keys, catch-up.
- Peer quorum: vote validation before voting, pinned keys, commit acknowledgement, catch-up trust model.
- HTTP peer endpoints (`/tx`, `/vote`, `/commit`, `/propose`, `/status`, `/txs`) and the main service API.
- Marketplace authorization, orders, disputes, capacity, treasury, paymaster.
- IoT/M2M signed telemetry and settlement.
- Key derivation, addresses, sender signatures.
- Accidental secret exposure or authentication bypass.

## Out of scope

- Research labs (`src/lab/`, `src/agent/`, `uep-core/` ZK circuits with development keys).
- Denial-of-service that only consumes local resources on a single node (unless it breaks consensus or value conservation).
- Social engineering, physical attacks, or issues that require compromising the operator's keys.
- Findings that depend on running with `NODE_ENV=production` while using development ZK keys (explicitly refused).
- Issues already documented as accepted residuals in `docs/PHASE-4-ASSESSMENT.md` or `docs/THREAT-MODEL.md`.

## Severity guidance

| Level | Examples |
|-------|----------|
| Critical | Unauthorized spend of notes, double-spend across the quorum, snapshot forgery that is accepted, secret leakage that allows control |
| High | Bypass of vote validation, catch-up of an unpinned snapshot, Marketplace order access by a non-party, fee calculation that breaks conservation |
| Medium | Rate-limit bypass that enables sustained abuse, missing input validation that leads to crash loops, information disclosure of non-secret data |
| Low / Info | Documentation mismatches, missing headers, non-exploitable DoS vectors on local harness |

## How to report

1. Prefer the private channel: **uep.dev@proton.me**.
2. Do **not** open a public GitHub issue for anything that could be exploited.
3. Include:
   - Version / commit
   - Clear reproduction steps (or a failing test)
   - Expected vs actual
   - Impact assessment
   - Whether the issue is already mitigated by operator configuration (pins, firewall, etc.)

We aim to acknowledge within a few days. Fixes land on `main` with a CHANGELOG entry. Public disclosure is coordinated.

## Independent assessment

An independent assessment of the Phase 4/5 harness is welcome. The package to run is:

```text
npm install
npm run test:consensus
```

See `docs/PHASE-4-ASSESSMENT.md` for what the harness claims and what it does not claim. An assessment report should state the exact commit, the commands run, and the findings (or the absence of critical/high findings). It does not make the protocol production-ready.

## Monitoring for public nodes

`GET /status` (unauthenticated) returns:

- `id`, `version`, `height`, `txCount`, `stateRoot`, `publicKeyHex`
- `startedAt`, `uptimeMs`
- `peerCount`, `threshold`
- `rateLimit` counters (`windowMs`, `max`, `recentHits`)

`GET /txs` returns the last twenty transaction ids (no openings).

Operators should scrape `/status` for height/root drift and uptime. Do not expose the peer port to the open internet without a firewall or reverse proxy.

## Contact

Security: uep.dev@proton.me  
Public discussion: GitHub issues (non-sensitive only)
