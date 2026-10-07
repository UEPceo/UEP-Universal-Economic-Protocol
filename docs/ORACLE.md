# Oracle layer (v0.5.2, hardened and wired in v0.5.3)

Status: **IMPLEMENTED (testnet reference)**. Verifiable economic evidence for
**policy evaluation only** (SVC SLA, IoT tariff, dispute evidence, AMM/swap
price checks). The oracle never moves funds and is never queried on the spend
or consensus path.

- Commitments use the repository Poseidon BN254 (`src/core/poseidon.ts`). The
  incoming homemade permutation that claimed to be Poseidon was removed.
- Heights for staleness and future drift (ADR 0002). Synchronous Ed25519 via
  `src/core/ed25519.ts`. Strict public-key equality against the registry.
- A `SettlementAuthorization` is a single-use voucher for a guard to consume;
  the oracle itself does not settle.

Residual limits: configured source keys only (no on-network oracle consensus);
in-process; policy helpers are pure evaluation.

## Wiring (v0.5.3)

The oracle is consulted on three real paths through `OraclePolicyGate`
(`src/oracle/policy-gate.ts`, tests `src/oracle/oracle-wiring.test.ts`). The
gate requires a signature-checking aggregator and fails closed.

- **Marketplace.** `new DigitalServicesMarketplace({ oracleGate })`. A listing
  may carry signed `oracleReference = { baseAssetId, baseUnitsPerQuantity,
  maxDeviationPpm }`; its `unitPrice` must stay within the band of the oracle
  price of `baseUnitsPerQuantity` base units in the listing asset, at
  publication and again at every `reserve()`. A stale, missing or moved feed
  blocks new reservations (`ORACLE_STALE`, `ORACLE_POLICY_REJECTED`, …).
- **IoT/M2M.** `new IoTM2MService(marketplace, { requireOracleTariff: true })`
  requires every IoT listing to be oracle-bound and checks the tariff band
  plus the buyer's optional `maxCost` budget (`evaluateIotTariff`) before any
  state is touched. Oracle-bound IoT listings are checked even without the flag.
- **Hashlock swap** (`uep.service.swap.v1`, the Marketplace category; not the
  AMM lab pool). `new SwapCategory(port, index, networkId, { priceGate,
  maxSkewPpm, requireOracle })` checks the implied rate at `open()` for every
  pair with an oracle pair policy (or every pair with `requireOracle`).

The oracle never moves funds and is not on the ledger spend path; it decides
whether a Marketplace, IoT or swap operation may proceed.

## v0.5.3 hardening (EXP-063, V-1 … V-5; auditor V52-04)

Tests: `src/oracle/oracle-hardening.test.ts` (one negative test per issue).

| Issue | Fix |
|---|---|
| V-1 one key counted as several sources | The registry refuses a key already registered under another source id (`ORACLE_SOURCE_KEY_IN_USE`); the aggregator counts fresh quotes **per signing key**, so `minSources` cannot be met with one key. |
| V-2 silent key replacement | Re-registering a source id with a different key is refused (`ORACLE_SOURCE_EXISTS`); `rotateSourceKey(sourceId, key, height)` is the only way to change it, records `keyRotatedAtHeight`, and refuses keys used by another source. |
| V-3 / V52-04 cross-network replay | Quote payload v2 contains the `networkId`; the domain separator `UEP_ORACLE_QUOTE_v0.2|<networkId>` comes from the verifier's local `policy.networkId`, never from the quote. A quote that names another domain is `DOMAIN_MISMATCH`; a relabelled one fails the signature. Archived v0.1 quotes verify only with `acceptLegacyV1Quotes: true` (`canonicalQuotePayloadV1`, `signQuoteV1` for tests). |
| V-4 one heavy source dominates the median | Effective weights are capped so one key carries strictly less than `maxSourceWeightSharePpm` (default one half) of the total; with weights 100/1/1 the two agreeing sources set the price. |
| V-5 forgeable `SettlementAuthorization` | Vouchers are version 2: a hash over every field (amount, recipient, asset, expiry, context, nonce, network, policy hash) signed by a policy authority key. `AuthorizationLedger({ trustedAuthorityKeys, networkId })` refuses unsigned, edited, foreign-network or untrusted vouchers (`AUTH_UNSIGNED`, `AUTH_FORGED`, `AUTH_NETWORK_MISMATCH`). Unsigned vouchers are accepted only with `testOnlyAcceptUnsigned` (refused under `NODE_ENV=production`). |
| `publishSync` bypass | Refused when `requireSignatures` is on. |

## Data sources: what may and may not enter policies or state

- **FX reference rates (ECB, BIS) are display-only.** They may be shown to users next to a price; they never enter a policy, a quote feed, a settlement or any state. UEP has no common currency or reference unit, and an oracle price is always a price between two concrete assets.
- **Physical-trigger oracle adapters** (not built yet) must, when built: use at least **2 distinct origins** plus **k-of-n signed evidence**; store the URL and the HTTP status per evidence leaf; discard any non-200 response. Adapters run outside transitions (no network access inside a transition, ADR 0002).
- **NWS and IMF are not used as sources.**
- **LEI** is only an optional provider field, validated offline with the ISO 17442 checksum (ISO 7064 MOD 97-10); no cache, no network call.
- **Leap-seconds file:** deferred. Any future use is in an exporter only (display of wall-clock conversions), never in state; UEP time is the block height.
