# Integration plan: settlement engine, category modules and oracle layer (v0.5.2)

Status: **implemented** and released as `0.5.2-public-iot-m2m` / tag `v0.5.2`. Plan written before
implementation (step 0.4 of the integration guide), then kept up to date with the
decisions taken while integrating. Scope is the public
testnet / reference implementation. Nothing here is a production, ZK or
throughput claim.

## 0. Baseline

| Suite | Before integration (Node 22.23.3, branch base c339b4a) |
| --- | --- |
| `npm test` protocol | 140/140 (the guide expected 96: the repo grew since it was written) |
| `npm test` marketplace + IoT + HTTP | 173/173 (guide expected 121) |
| incoming settlement (isolated) | 8/8 |
| incoming oracle (isolated) | 30/30 |
| incoming adapted-modules (isolated, own `npm install`) | 63/63 |

The isolated runs used a scratch copy outside the repository, because the
incoming packages carry their own `package.json`, `tsconfig.json` and a
TypeScript 5.7 / 7.0 dev dependency that the repository does not use.

## 1. Target layout

| Incoming | Destination | Notes |
| --- | --- | --- |
| `uep-settlement/src/settlement/engine.ts`, `types.ts` | `src/settlement/engine.ts`, `types.ts`, `index.ts` | Rewritten as the single payout executor behind the Marketplace (see 3). No order state machine, no clock. |
| `uep-settlement/src/settlement/batch.ts` | `src/settlement/batch.ts` | Receipt batch root and inclusion proofs over the shared RFC 9162 tree. No timers, no `performance`. |
| `uep-settlement/src/settlement/canonical.ts` | removed | Replaced by `src/core/canonical-json.ts`. |
| `uep-settlement/src/settlement/reference-ledger.ts` | removed | Duplicate ledger. The Marketplace balances are the ledger port. |
| `uep-adapted-modules-v2/src/category/{swap,relay,dispute,disputable,drip}.ts` | `src/category/*.ts` | bigint amounts, heights, Marketplace identities, Marketplace escrow port, Marketplace treasury. |
| `uep-adapted-modules-v2/src/uep/settlement-index.ts` | `src/category/settlement-index.ts` | bigint fee, height stamps. |
| `uep-adapted-modules-v2/src/uep/registry.ts` (`ReplayGuard`, `MonotonicClock`, `Signed<B>`) | `src/category/signed.ts` | `KeyRegistry` and its proof of possession removed: keys come from Marketplace identities. `MonotonicClock` becomes a height monotonicity guard. |
| `uep-adapted-modules-v2/src/uep/crypto.ts` hashlock | `src/category/swap.ts` | Kept (no repo equivalent). |
| `uep-adapted-modules-v2/src/uep/crypto.ts` ChaCha20, HKDF wrap key, key commitment | `src/category/relay-crypto.ts` | Kept (no repo equivalent). |
| `uep-adapted-modules-v2/src/uep/crypto.ts` RFC 6962/9162 Merkle | `src/core/rfc9162-merkle.ts` | Shared by relay and the settlement batch. The settlement batch's own tree (which duplicated odd nodes) is dropped. |
| `uep-adapted-modules-v2/src/uep/crypto.ts` Ed25519, `acct_` ids | removed | `src/core/ed25519.ts` and Marketplace identities. |
| `uep-adapted-modules-v2/src/uep/{ids,canonical,ledger,treasury,fees}.ts` | removed | `src/core/assets.ts` / Marketplace asset rule, `src/core/canonical-json.ts`, Marketplace balances, `MarketplaceTreasury`, `calculateMarketplaceFee` / `creatorFee`. |
| `uep-oracle-layer/src/oracle/{types,registry,verifier,index,risk-policy}.ts` | `src/oracle/*.ts` | Heights, bigint, synchronous verification with core Ed25519, strict key equality. |
| `uep-oracle-layer/src/oracle/canonical.ts` | `src/oracle/canonical.ts` | Fake `poseidon2` removed; commitments use `src/core/poseidon.ts` (`poseidonDomainHash`). |
| `uep-oracle-layer/src/oracle/mock.ts` | `src/oracle/testkit.ts` | Deterministic test keys only; `MockSettlementEngine` (a fake ledger) removed. |
| incoming tests | co-located `*.test.ts` next to each module | Converted to bigint and heights; integration tests added (see 6). |
| incoming docs | `docs/SETTLEMENT.md`, `docs/CATEGORY-MODULES.md`, `docs/ORACLE.md`, `docs/history/CATEGORY-INTEGRATION-NOTES.md`, `docs/history/SETTLEMENT-INTEGRATION-NOTES.md` | English, accurate scope, residual limits listed. |

`incoming/` is deleted once its content lives in `src/` and `docs/`.

## 2. Shared rules applied to every integrated module

- **Amounts (ADR 0001):** `bigint` at every module boundary. A `number`, a negative
  value or a non-integer is refused (`AMOUNT_INVALID`); nothing is converted silently.
- **Time (ADR 0002):** block heights from the Marketplace `TransitionClock`. No
  module takes a `now` argument or reads a clock. Durations given in seconds by
  the incoming packages are converted with the 5 s reference block
  (`7 d = 120 960`, fraud window minimum `60 s = 12`, dispute evidence
  `3 600 s = 720`, drip cooldown `30 s = 6`, drip window `3 600 s = 720`,
  drip validity `1 d = 17 280`).
- **Identities and signatures:** every fund-moving action is a Marketplace
  `ActorAuth` (the actor's Ed25519 signature over the canonical, domain-separated
  action message) verified against the key registered with the Marketplace.
  Category actions carry a nonce in the signed details and a per-scope
  `ReplayGuard`; the incoming `KeyRegistry` is not kept.
- **Determinism lint and poisoned clock:** `src/settlement`, `src/category` and
  `src/oracle` are added to the scanned directories; their transition classes are
  wrapped by the poisoned-clock harness.
- **Canonical encoding:** `src/core/canonical-json.ts` (strict: rejects floats,
  `undefined`, class instances; bigint encoded as a decimal string tag). It is kept
  separate from `stableStringify` on purpose: `stableStringify` bytes are already
  signed by existing clients, so changing it would invalidate signatures.

## 3. Merge decisions for problem (d): one dispute model, one fee path, one payout executor

1. **Order state stays in the Marketplace.** The Marketplace keeps order status,
   capacity, deposits, guards, the signed-action flow and its `SettlementRecord`.
2. **One payout executor.** `src/settlement/engine.ts` (`SettlementEngine`) is the
   only code that closes an escrow into provider net, fee, gas and buyer refund.
   The Marketplace `payout()` path and every category payout (swap maker leg,
   relay price) call it through a ledger port; neither mutates `held` or
   `accounts` for a payout directly any more.
   The engine plans first (pure), checks conservation
   (`escrow = providerNet + fee + gas + buyerRefund`), checks that the treasury has
   not settled the order and that the paymaster quote is the sponsored one, and only
   then commits. It returns a receipt with a canonical hash; executing the same order
   twice is refused (`SETTLEMENT_ALREADY_EXECUTED`), re-entry is refused
   (`SETTLEMENT_REENTRANT`).
3. **One fee path.** Protocol fee `max(1, floor(amount·10/10 000))` only on ledger
   spends (`src/core/fee.ts`, unchanged). Marketplace fee
   `max(1, floor(amount·300/10 000))` only on the provider part of a settled order,
   via `MarketplaceTreasury.settleMarketplaceFee`; buckets 40/25/20/15 with the
   repository's floor-plus-remainder-to-OPERATIONS rule (the incoming
   largest-remainder split is dropped).
   - Swap and relay no longer charge the protocol fee on business-layer releases
     (they are not ledger spends).
   - Swap: the market maker is the provider; the marketplace fee is charged on the
     fromAsset leg the maker receives. The buyer receives the toAsset leg in full.
4. **One outcome model.** `RELEASE` / `REFUND_BUYER` / `SPLIT`, expressed as a
   provider amount (Marketplace) or `releaseBps` (categories). Two front-ends share
   the same payout plan and fee path:
   - Marketplace orders: the configured single arbiter (`resolveDispute`).
   - Swap and relay: `DisputeCategory`, a k-of-n arbiter quorum with bonds.
   Timeout default refunds the buyer in both. A Marketplace `RELEASE` timeout still
   runs the category guard and refunds when it fails (v0.4.6). The category dispute
   keeps the `5000` split-on-timeout option, default `0` (D-5 still pending).
5. **Adapted-modules README choices confirmed:** forfeited/slashed bonds 80 %
   injured party / 20 % treasury risk reserve; forfeiture only with
   `frivolous: true` on a full loss; dispute timeout refunds the buyer; bond
   `max(50, 1 % of escrow)` and one dispute per order; drip at most 50 % of the
   order's marketplace fee, once per order; dust returned to the locker; quorum is a
   strict majority.
6. **Treasury credits outside the fee path** (slashes, forfeited bonds) go to
   `RISK_RESERVE` with a new entry reason `RISK_RESERVE_TRANSFER`. Drip subsidies
   are paid from `DISTRIBUTABLE_PROFIT` within an administrator-signed drip budget
   (entry reason `DRIP_SUBSIDY`).
7. **Value accounting** gains additive fields: `categoryHeld`, `treasuryTransfers`,
   `subsidiesPaid`; the conservation equation becomes
   `credited = available + lockedDeposits + held + categoryHeld + marketplaceFees + gasCaptured + treasuryTransfers − subsidiesPaid`.
   Existing fields keep their meaning.

## 4. Wiring

1. Marketplace payout → `SettlementEngine` (Marketplace ledger port over its own maps).
2. IoT guard → `src/service/iot-m2m.ts` verified telemetry (unchanged; covered by new integration tests with and without verified telemetry).
3. Swap / relay / dispute obtain a **category escrow port** from the Marketplace
   (issued once per module): holds against Marketplace accounts, payouts through
   the settlement engine, treasury credits through the Marketplace treasury.
   Drip spends through a treasury drip capability issued once.
4. Oracle is used only in policy evaluation: an SVC SLA settlement guard, the IoT
   tariff check, dispute evidence commitments and an optional swap price check.
   A test asserts that `src/core` and `src/testnet` never import `src/oracle`, and
   the oracle never holds a ledger or balance reference.
5. Drip reads only the settlement index written by swap and relay settlement.
6. The HTTP / service API lab does not expose the new flows in this release
   (fail closed: no unauthenticated route is added).

## 5. Attack battery (BATTERY-2026-10-05)

| Item | Decision |
| --- | --- |
| Ledger double spend under concurrency (critical) | The synchronous `UepLedger.submit` already runs verify + nullifier + apply in one turn. Added: a re-entrancy guard (`LEDGER_BUSY`) and `SpendSerializer`, a FIFO lock for adapters that await an async verifier before submitting; test with two concurrent spends of one note. |
| Fee arithmetic | Already bigint (`creatorFee`, `calculateMarketplaceFee`); conservation checks kept and extended to the engine. |
| Sybil slot saturation | Per-identity cap on unfunded reservations per listing (`maxUnfundedReservationsPerListing`, default 3) on top of the existing per-identity cap (8) and the deposit that is forfeited on expiry. A non-refundable reservation fee is not added (it would change existing economics); Sybil identities remain a documented residual risk. |
| Cancel vs accept race | `order.version` and an optional `expectedVersion` on state-changing calls (`ORDER_STATE_CONFLICT`). |
| Paymaster drain | The sponsorship is a hold captured only on a settled payout and released on cancel / expiry / refund (already the case); a create/cancel loop test is added. |
| Relay all-or-nothing | `custodyBps` (default 2 000): once the provider publishes the committed key, 20 % of the price is the custody tranche and is paid unless fraud is proven; disputes and timeouts apply `releaseBps` to the 80 % delivery tranche only. |
| IoT synthetic telemetry | Deferred to the Evidence system (multi-attester sets). No hardware attestation is simulated. |
| HPKE for relay payloads | Deferred (later phase); payload digests remain visible to relayers. |

## 6. Tests

- Incoming suites moved next to their modules (`src/settlement/*.test.ts`,
  `src/category/*.test.ts`, `src/oracle/*.test.ts`), converted to bigint and heights.
- Integration tests: order → hold → delivery → dispute / settle → fee split →
  treasury → drip with conservation after each step; IoT with and without verified
  telemetry; swap and relay happy path and fraud / slash; oracle stale quote, replay,
  source pause and circuit breaker; oracle evidence in an SVC SLA settlement.
- Scripts `test:settlement`, `test:oracle`, `test:category`, included in `test:all`
  (CI runs `test:all` on Node 22 and 24).

## 7. Residual limits (also listed in the docs)

- Category commitments (hashlock, relay key commitment, chunk trees) are SHA-256,
  not Poseidon; the oracle commitment uses the core Poseidon.
- In-process isolation only: capabilities are object references inside one process.
- Time is the Marketplace height; it is only as good as the height source.
- No arbiter appeal, no arbiter staking or rotation.
- Oracle sources are configured keys; there is no on-network oracle consensus.
