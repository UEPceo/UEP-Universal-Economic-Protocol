# ADR 0001: Unit of account and asset model

- Status: accepted for the asset manifest (v0.5.0); ledger integration pending.
- Scope: D-1 (unit of account) and D-3 (asset model) of the multi-asset milestone.
- Code: `src/core/asset-registry.ts`, `src/core/assets.ts`, tests in `src/core/asset-registry.test.ts`.

UEP has no native token and no universal coin. Every amount belongs to one asset, and amounts of different assets are never added together.

## D-1: unit of account

- An `amount` is always a u64 integer in the smallest unit of its asset. The canonical JSON form is `^(0|[1-9][0-9]*)$`.
- `decimals` is declared per asset, is at most 8 (`MAX_ASSET_DECIMALS`) and is immutable. Changing the decimals means creating a new asset. `decimals` only affects formatting, never consensus arithmetic, but it is part of the manifest hash.
- Resource credits (`kind: "resource-credit"`, for example energy or data) carry a `measurement` (`quantity`, `unit`, `evidence`). The measured quantity is evidence and stays separate from the settlement amount.

## D-3: asset model

The model is registry → asset definition → issuer key set → controlled issuance. Issuers cannot create assets: an asset exists only if a governance-signed manifest lists it.

### Asset ids (namespaced)

- Format: `<namespace>/<symbol>`, lowercase ASCII, at most 31 bytes (`ASSET_ID_PATTERN`).
  - Namespace: `[a-z0-9][a-z0-9-]{0,14}`.
  - Symbol: `[a-z0-9][a-z0-9._-]{0,14}`.
- Valid ids are short and never start with a zero byte, so `encodeStringToFr` is injective over them: two different ids never map to the same field element.
- Composite keys (asset, account) are structural in every layer. Circuit v4 keys the state tree by `(account, asset)`.
- v0.5.0 renamed the development assets to this format, for example `uep-test/teur`.

### Registry manifest

`AssetRegistryManifest` contains:

- `format` and `formatVersion`;
- `networkId`;
- `version`, plus `previousManifestHash` for a hash chain;
- `namespaces`;
- `assets`.

Rules:

- A governance key set `{ keys, threshold }` signs the manifest hash.
- `verifySignedAssetRegistry` requires `threshold` distinct valid signatures. `validateAssetRegistryUpgrade` requires the version to go up by one and the chain to link to the previous manifest.
- Assets are never removed, only deprecated.
- These fields are immutable across versions: `symbol`, `kind`, `decimals`, `minProtocolFee`, `supplyCap`, `unit` and `measurement`. As a result, replaying history never depends on the manifest version.

### Issuer key sets and thresholds

- Each asset has its own issuer key set `{ keys, threshold }`. A mint is valid with `threshold` distinct valid signatures.
  - Development registries use threshold 1.
  - M-of-N uses the same code path and is tested (2-of-3).
- Key separation rules:
  - issuer keys are never shared between assets;
  - issuer keys never equal a namespace-owner key or a governance key;
  - governance keys are separate from snapshot and arbiter keys.
- Re-keying an issuer means a new manifest version. Revocation does not apply retroactively: mints made before the change stay valid. A compromised asset can be halted and replaced by a successor asset.

### Openability

The manifest is designed so that the registry can be opened later without changing the id format:

- **Namespace ownership.** Each namespace has an `owner` key set. Every asset under a namespace carries `approvals` from that owner over `assetAdmissionMessage(networkId, asset)`, which binds the namespace to its owner's keys.
- **Self-certifying namespaces.** Namespaces starting with `k-` are derived from the owner key set (`selfCertifiedNamespace`, domain `UEP-NAMESPACE-v1`). Anyone can claim one without asking for a name, and nobody else can use it.
- **Extension points (not implemented, decision of the maintainers):**
  - who holds the governance keys in a public phase, and how they are rotated;
  - public admission requirements (anti-spam cost without a native token, or an allowlist);
  - delisting policy;
  - registration of human-readable namespaces for third parties;
  - how wallets show the issuer to prevent impersonation.

### Development registry

`devAssetRegistry(networkId)` builds a signed manifest from the network templates using **ephemeral keys generated in memory**. It is meant for local tests and demos only. No persistent private key is committed or generated to disk. A real deployment supplies its own manifest and key sets through configuration.

## Pending: ledger integration (next milestone)

The ledger still uses the static templates in `assets.ts`. It also keeps a per-asset issuer signer map that falls back to the faucet key. The planned integration:

1. **Snapshot format 8** (format 7 added the ledger height, ADR 0002). The snapshot commits `registryVersion` and `registryHash`. `restore()` rejects a snapshot whose registry does not match the trusted manifest, and checks mints against the registry in the same way as transactions.
2. **Threshold-signed mints.** The mint message includes the asset id, the issuer key epoch and the registry hash. The ledger verifies `meetsThreshold` against the issuer key set in force at that point of the log.
3. **Fee floor from the registry (audit V47-04).** The fee floor is read from the immutable `minProtocolFee` of the registered asset (`AssetRegistry.feeFloor`). Because the floor is immutable, replay is independent of the manifest version.
4. **No faucet fallback (audit DC-01 / V47-05).** An asset with no issuer key set cannot be minted. The shared faucet key is restricted to explicitly listed development assets.
5. **Key separation enforced at load (audit DC-02).** The ledger refuses a configuration in which the faucet, snapshot, governance or issuer keys overlap.
6. **Circuit limitation.** The spend circuit fixes `MIN_PROTOCOL_FEE = 1` (`uep-core/uep-26-spend-circuit/lib.rs`). Until the floor becomes a public input, ZK-proven transfers are limited to assets with `minProtocolFee = 1`. A floor above 1 must not be admitted for an asset meant for the ZK path (not enforced by the validator yet).

## Consequences

- Asset ids in snapshots, fixtures and API calls use the namespaced format. Pre-release snapshots that use the old ids do not restore.
- Adding, re-keying or deprecating an asset becomes a signed data change instead of a code change, once the ledger integration lands.
