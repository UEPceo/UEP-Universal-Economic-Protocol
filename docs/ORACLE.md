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
(`src/oracle/policy-gate.ts`, tests `src/oracle/oracle-wiring.test.ts` and
`src/oracle/oracle-liveness.test.ts`). The gate requires a signature-checking
aggregator.

**No-dependency rule.** The oracle is never required for value already in
flight: funding, delivery, settlement, cancellation, refunds, disputes and
their timeouts, reservation expiry, IoT holds and settlement, swap settle and
expire, and ledger transfers never consult it (`oracle-liveness.test.ts` runs
all of them with the oracle healthy, stale, down, paused and with one
outlier). The oracle can only gate *new* operations, and only when the
operation's own signed terms opt in:

- an available quote outside the signed band rejects the new operation
  (`ORACLE_POLICY_REJECTED`);
- when the oracle is unavailable (no gate, stale, unknown or paused pair, no
  sources, or fewer than `minSources` agreeing sources), the signed
  `onOracleUnavailable` decides: `FOLLOW_SIGNED_PRICE` (default) continues at
  the signed price, `BLOCK_NEW` refuses new operations only;
- the outcome is stored with the order / swap (`oracleCheck`: `IN_BAND` with
  the hash of the aggregated quote used, or `ORACLE_UNAVAILABLE_SIGNED_PRICE`
  with the reason), so the decision can be replayed.

**Prices between assets are for bands and policies only.** An oracle price is
always a price between two concrete assets. It is used to check a signed
price against a band or to evaluate a policy, never as a unit of account: no
balance, fee, receipt or settlement is denominated in or converted through a
reference asset. UEP has no native token and no common currency.

**Aggregation.** Only quotes of sources that are registered `ACTIVE` now and
signed with their current key count. One signing key counts once. A source
farther than the pair band from the weighted median is dropped on its own;
the feed answers while at least `minSources` sources remain and agree within
the band. With two sources that disagree beyond the band no outlier can be
identified and the feed is unavailable (`DEVIATION`). At an exact half split
of weight (for example two sources) the price is the floor of the mean of the
two middle quotes.

- **Marketplace.** `new DigitalServicesMarketplace({ oracleGate })`. A listing
  may carry signed `oracleReference = { baseAssetId, baseUnitsPerQuantity,
  maxDeviationPpm, onOracleUnavailable? }`; its `unitPrice` must stay within
  the band of the oracle price of `baseUnitsPerQuantity` base units in the
  listing asset, at publication (`listing.publishOracleCheck`) and at every
  `reserve()` (`order.oracleCheck`).
- **IoT/M2M.** Oracle binding is per listing: an IoT listing with
  `oracleReference` is tariff-checked (band plus the buyer's optional
  `maxCost` budget, `evaluateIotTariff`) before any state is touched. The
  service option `requireOracleTariff` is a deprecated compatibility shim
  with no effect.
- **Hashlock swap** (`uep.service.swap.v1`, the Marketplace category; not the
  AMM lab pool). `new SwapCategory(port, index, networkId, { priceGate })`.
  The rate check is an explicit per-swap opt-in: the buyer signs
  `oracleBand = { maxSkewPpm, onOracleUnavailable? }` inside the intent (part
  of the intent id). Only then is the implied rate checked at `open()`, and
  the outcome is stored on the swap (`oracleCheck`, with the hash of the
  aggregated quote used). A registry pair policy or a pair pause never makes
  a swap oracle-bound; `setPairPaused` no longer creates a pair policy. The
  constructor options `maxSkewPpm` and `requireOracle` are deprecated shims
  with no effect on which swaps are checked.

The oracle never moves funds and is not on the ledger spend path; it can only
decide whether a new, opted-in Marketplace, IoT or swap operation proceeds.

## v0.5.3 hardening (EXP-063, V-1 … V-5; review item V52-04)

Tests: `src/oracle/oracle-hardening.test.ts` (one negative test per issue).

| Issue | Fix |
|---|---|
| V-1 one key counted as several sources | The registry refuses a key already registered under another source id (`ORACLE_SOURCE_KEY_IN_USE`); the aggregator counts fresh quotes **per signing key**, so `minSources` cannot be met with one key. |
| V-2 silent key replacement | Re-registering a source id with a different key is refused (`ORACLE_SOURCE_EXISTS`); `rotateSourceKey(sourceId, key, height)` is the only way to change it, records `keyRotatedAtHeight`, and refuses keys used by another source. |
| V-3 / V52-04 cross-network replay | Quote payload v2 contains the `networkId`; the domain separator `UEP_ORACLE_QUOTE_v0.2|<networkId>` comes from the verifier's local `policy.networkId`, never from the quote. A quote that names another domain is `DOMAIN_MISMATCH`; a relabelled one fails the signature. Archived v0.1 quotes verify only with `acceptLegacyV1Quotes: true` (`canonicalQuotePayloadV1`, `signQuoteV1` for tests). |
| V-4 one heavy source dominates the median | Effective weights are capped so one key carries strictly less than `maxSourceWeightSharePpm` (default one half) of the total; with weights 100/1/1 the two agreeing sources set the price. |
| V-5 forgeable `SettlementAuthorization` | Vouchers are version 2: a hash over every field (amount, recipient, asset, expiry, context, nonce, network, policy hash) signed by a policy authority key. `AuthorizationLedger({ trustedAuthorityKeys, networkId })` refuses unsigned, edited, foreign-network or untrusted vouchers (`AUTH_UNSIGNED`, `AUTH_FORGED`, `AUTH_NETWORK_MISMATCH`). Unsigned vouchers are accepted only with `testOnlyAcceptUnsigned` (refused under `NODE_ENV=production`). |
| `publishSync` bypass | Refused when `requireSignatures` is on. |
| Registry follow-ups (v0.5.3) | A rotated-out key, or the key of a revoked source, is retired: its quotes stop counting at once and it can never be registered again (`ORACLE_SOURCE_KEY_RETIRED`). `REVOKED` is final. Re-registering with the same key changes metadata only, never the weight or the status. Keys must be prime-order Ed25519 points. `AuthorizationLedger` requires a `networkId` and refuses vouchers that name none. The gate refuses an aggregator that accepts unbound v0.1 quotes, and the Marketplace refuses a gate whose oracle network differs from its ledger network (`ORACLE_NETWORK_MISMATCH`). |

## Data sources: what may and may not enter policies or state

- **FX reference rates (ECB, BIS) are display-only.** They may be shown to users next to a price; they never enter a policy, a quote feed, a settlement or any state. UEP has no common currency or reference unit, and an oracle price is always a price between two concrete assets.
- **Physical-trigger oracle adapters** (not built yet) must, when built: use at least **2 distinct origins** plus **k-of-n signed evidence**; store the URL and the HTTP status per evidence leaf; discard any non-200 response. Adapters run outside transitions (no network access inside a transition, ADR 0002).
- **NWS and IMF are not used as sources.**
- **LEI** is only an optional, informational provider field. When present it is checked offline with `isValidLei()` (`src/oracle/lei.ts`: ISO 17442 format and ISO 7064 MOD 97-10 checksum); no cache, no registry lookup, no network call. A valid checksum does not prove the entity exists, and an LEI never enters a policy decision or state.
- **Leap-seconds file:** deferred. Any future use is in an exporter only (display of wall-clock conversions), never in state; UEP time is the block height.
