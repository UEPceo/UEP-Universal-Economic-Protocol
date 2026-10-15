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

- **FX reference rates and statistics (ECB, BIS, Eurostat) are display-only. The World Bank source shown in 0.5.82 was removed in 0.5.83 by director decision and is not used anywhere in UEP.** Since 0.5.82 `src/service/indicative-display.ts` (`GET /v1/display/indicators`) shows them with attribution, the time of the consultation and "no disponible" when a source does not answer (same pattern as the GLEIF display). Their reuse terms have not been reviewed for this project. They may be shown to users next to a price; they never enter a policy, a quote feed, a settlement or any state. UEP has no common currency or reference unit, and an oracle price is always a price between two concrete assets.
- **Physical-trigger oracle adapters** (USGS and GEOFON adapters since 0.5.83, off-node, not wired to settlement) must: use at least **2 distinct origins** plus **k-of-n signed evidence**; store the URL and the HTTP status per evidence leaf; discard any non-200 response. Adapters run outside transitions (no network access inside a transition, ADR 0002).
- **Discarded (not used, not planned):** IERS Bulletin A, CoinGecko or any crypto price API, NWS, IMF, OpenAQ, Copernicus downloads, and any binding spot price. UEP has no reference price in state.
- **Phase 2.3 seismic HOLD (design only):** USGS (public domain) and GEOFON (CC BY 4.0, attribution "GEOFON Data Centre, GFZ Helmholtz Centre Potsdam" required). **EMSC:** only with written permission; not used until then.
- **Lab only:** NOAA SWPC, JPL Horizons, NAIF LSK, CelesTrak, DSN, and Open-Meteo (non-commercial terms: lab and demos only, never a deployed service).
- **Watch list:** MPC, data.europa.eu, Copernicus STAC.
### Sources table (0.5.83)

| Source | Adapter (off-node) | Use | Licence (re-checked 2026-10-15) | Attribution | Account |
|---|---|---|---|---|---|
| USGS FDSN event | `scripts/adapters/seismic.mjs`, `usgs-seismic.mjs` | Phase 2.3 seismic HOLD, origin 1 (canonical SEISMIC claim; not wired to settlement) | Public domain (U.S. Government work) | "U.S. Geological Survey, Earthquake Hazards Program" | No |
| GEOFON FDSN event | `scripts/adapters/seismic.mjs`, `geofon-seismic.mjs` | Phase 2.3 seismic HOLD, origin 2 | CC BY 4.0 for event products ([FAQ](https://geofon.gfz.de/eqinfo/faq/)); waveforms are under different, network-specific licences and are **not used** | **Required, exactly:** "Event locations were obtained from the GEOFON program of the GFZ Helmholtz Centre for Geosciences using data from the GEVN partner networks." | No |
| NOAA SWPC Kp, F10.7 | `scripts/adapters/lab-sources.mjs` | Lab only (`UEP_LAB_SOURCES=1`) | Public domain (U.S. Government work) | "NOAA Space Weather Prediction Center" | No |
| JPL Horizons | `lab-sources.mjs` | Lab only; offline SPK kernels preferred | U.S. Government work (NASA/JPL) | "JPL Solar System Dynamics, Horizons" | No |
| CelesTrak GP | `lab-sources.mjs` (`CelestrakClient`) | Lab only | No licence; [usage policy](https://celestrak.org/usage-policy.php): download once per update (GP data every 2 hours), stop on any non-200, no TLE format. The adapter only accepts `FORMAT=json` (OMM), caches each query for 2 hours and stops all queries after any non-200 until an operator resets it | "CelesTrak (T.S. Kelso)" | No |
| NASA DSN Now | `lab-sources.mjs` | Lab only | NASA data CC0 unless noted ([NASA licence](https://science.data.nasa.gov/about/license)); NASA logos and insignia are not public domain and are not used | "NASA Deep Space Network" | No |
| Open-Meteo | `lab-sources.mjs` | Lab only, **non-commercial only** (free API terms, < 10,000 calls/day); never a deployed service | CC BY 4.0 data | "Weather data by Open-Meteo.com (CC BY 4.0)" | No |
| ECB, BIS, Eurostat | `src/service/indicative-display.ts` (0.5.82) | UI display only, never state | see that file | shown in the UI | No |
| GLEIF | `src/oracle/lei.ts` (offline), `src/service/gleif-display.ts` | Offline checksum; UI display only | CC0 | shown in the UI | No |

Not integrated: **EMSC** (commercial use needs written permission), **IANA leap-seconds.list / IERS Leap_Second.dat** (waiting for the exporter), NAIF LSK (lab, offline file, no adapter yet), watch list (MPC, data.europa.eu, Copernicus STAC), and every discarded source below.

Every adapter: hard timeout (`SOURCE_TIMEOUT`), non-200 = unavailable (no partial evidence), strict UTF-8 and schema checks (`SOURCE_MALFORMED`), deterministic normalization (Unicode NFC, no trimming or case folding, decimals to scaled integers with BigInt, truncated toward zero), recorded fixtures in `scripts/adapters/fixtures/` so `npm run test:adapters` runs offline (global `fetch` is disabled in the tests). Lab adapters refuse to run without the explicit flag (`LAB_FLAG_REQUIRED`). Seismic cross-source agreement is undecided while the tolerances are unset (residual: 30-day study); a source that reports a matching event while the other does not is `SOURCES_DISCREPANT`.

- **Adapters run off-node.** Fetch code lives in `scripts/adapters/` and runs on attesters' machines; `npm run check:adapters` (CI) fails if `src/` imports it. With every source down, the ledger and the Marketplace behave identically (the listing's signed `onNoEvidence` outcome).
- **LEI** is only an optional, informational provider field. When present it is checked offline with `isValidLei()` (`src/oracle/lei.ts`: ISO 17442 format and ISO 7064 MOD 97-10 checksum). Check-digit pairs 00, 01 and 99 are rejected: the generator emits 02–98 only. No cache, no registry lookup, no network call on this path. A valid checksum does not prove the entity exists, and an LEI never enters a policy decision, a quote or state.
- **GLEIF** is display-only (`src/service/gleif-display.ts`, `GET /v1/display/lei`). The page shows the legal name, the registration status and the time of the consultation. If the registry does not answer, the page still shows the offline check. The answer is not evidence and is not written to state.
- **Leap-seconds file:** deferred. Any future use is in an exporter only (display of wall-clock conversions), never in state; UEP time is the block height.
