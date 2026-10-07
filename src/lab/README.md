# Research labs (`src/lab`)

| Field | Value |
|---|---|
| Status | Experimental (lab) |
| Since | 0.5.0 |
| Tests | npm run test:lab (blocking in CI), npm run test:lab:known (non-blocking) |
| Depends on | core; ZK bridge via the uep-zk binary |

## Purpose

Consensus and node labs (UEP-34…38), execution engine, transports, economic labs, the AMM lab pool (`liquidity.ts`, simulated 0.3 % pool fee, never charged by the testnet) and the ZK bridge.

## Notes

- Not part of the testnet rules and without any security claim.
- Known issues: `scripts/lab-known-issues.json`, explained in `docs/LABS.md`.

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
