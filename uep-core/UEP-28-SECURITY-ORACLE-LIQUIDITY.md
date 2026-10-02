# UEP-28 — Security policy, oracles, liquidity

**Status:** TESTNET modules **IMPLEMENTED / TESTED**. Production feeds and on-chain pools: **CONCEPTUAL**.

## Scope boundary

Does **not** modify:

- Poseidon parameters / SpendCircuit / 152 621 constraints
- Fee formula (0.1%)
- Nullifier / SMT consensus rules

These layers sit **above** the cryptographic spend path as node/wallet policy and market infrastructure.

## 1. Security policy (`src/core/security-policy.ts`)

Pre-submit gates:

| Control | Purpose |
|---|---|
| Global pause | Emergency halt of spends |
| Per-asset tier | experimental / registered / restricted / halted |
| Max transfer amount | Single-tx cap |
| Rolling window volume + tx count | Rate limit / anti-drain |
| Account blocklist | Targeted denial |
| Min fee | Optional floor |

Wired into `UepLedger.prepareSpend` → reject `POLICY` if verdict fails. Window commits after successful `submit`.

## 2. Oracles (`src/core/oracle.ts`)

- Multi-source quotes per `(base, quote)` asset pair
- Staleness window
- Inter-source deviation (ppm)
- Median aggregation
- `seedTestnetOracles()` for deterministic demos

Consensus **does not** require oracle data for basic P2P transfers. Liquidity / risk modules may require fresh quotes.

## 3. Liquidity (`src/core/liquidity.ts`)

- Constant-product AMM pools (`x * y = k`)
- Pool fee in ppm
- Optional **oracle skew circuit-breaker** (reject swap if spot vs mid exceeds ppm)

Demo pool: `pool:test:energy-eur`.

## Honesty

| Piece | Label |
|---|---|
| Policy engine | IMPLEMENTED / TESTED |
| Simulated oracle feeds | SIMULATED |
| Live external attestations | CONCEPTUAL |
| AMM math | IMPLEMENTED / TESTED |
| Production market network | CONCEPTUAL |

## Tests

`src/core/security-liquidity.test.ts` — included in `npm run test:uep`.
