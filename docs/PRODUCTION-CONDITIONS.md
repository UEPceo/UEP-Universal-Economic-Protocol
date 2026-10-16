# Production conditions (0.5.84, item 4)

Status: **proposal.** The values in `config/production-conditions.json` are proposals for the maintainer to confirm or change. Time is block height only (reference block time 5 s).

## v1 signature sunset

0.5.83 accepted legacy v1 Marketplace/IoT signatures outside production until `construction height + 6 307 200`. That height is relative to when the node object was built, so a restarted node moved its own sunset. 0.5.84 proposes per network type:

| Network | Rule | Proposed value |
|---|---|---|
| lab | relative (0.5.83 behaviour) | +6 307 200 heights (≈ 1 year) |
| testnet | **absolute**, same for every node and every restart | height **3 153 600** (≈ 6 months of 5 s blocks from genesis) |
| mainnet | refused from genesis | — |

`legacyV1ConfigFor(kind, conditions, height)` returns the Marketplace `legacyV1Signatures` option; `v1MigrationStatus()` reports heights left.

### Migration procedure (v1 → v2)

1. Announce the sunset height (testnet 3 153 600, proposal) in the release notes and to integrators.
2. Clients upgrade to the 0.5.83+ SDK and sign v2 (`signActionV2`, `signReservationV2`, `envelopeV2`, `newSignatureNonce()`); v2 binds network, domain, nonce and a height window.
3. Operators watch `LegacyV1Policy.accepted` (counter) and the one-time `UEP_V1_SIGNATURE` deprecation warning to find remaining v1 clients.
4. At the sunset height every node refuses v1 with `LEGACY_V1_SIGNATURE_SUNSET`; no state migration is needed (v1 and v2 records coexist in snapshots; nonces are v2 only).
5. In 0.6.0 the shim is removed.

## Asset registry: when it becomes mandatory

| Network | Required | From height |
|---|---|---|
| lab | no | — |
| testnet | yes (proposal) | 3 153 600 |
| mainnet | yes | 0 (genesis) |

`registryPolicyFor(kind, conditions, networkId, governance)` builds the `NetworkRegistryPolicy`; it fails with `PRODUCTION_CONDITIONS_UNMET` for testnet/mainnet without a pinned governance key set, i.e. until the key ceremony ([GOVERNANCE-KEY-CEREMONY.md](./GOVERNANCE-KEY-CEREMONY.md)) has been performed. `assertRegistryPolicy(..., height)` applies the requirement from `requiredFromHeight`; without a height it applies it (conservative).

## Decisions for the maintainer

- Confirm or change the testnet sunset height and the testnet registry height (both proposed at 3 153 600).
- Perform the governance key ceremony (participants, threshold, custody: see the ceremony document).
- Confirm that mainnet refuses v1 from genesis and requires the registry from genesis.

Tests: `src/network/production-conditions.test.ts`.
