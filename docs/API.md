# Public API reference: changed signatures (v0.4.3)

This page lists the public signatures that changed in `0.4.3-public-iot-m2m`. Everything else is unchanged; see the source for full types. Error codes are thrown as `Error(message)` where the message starts with the code.

## Ed25519 helpers: `src/core/ed25519.ts` (new)

Built on `node:crypto`; no third-party dependency. Public keys are exchanged as hex SPKI DER (`publicKeyHex`). Raw 32-byte hex, PEM and `KeyObject` are also accepted.

```ts
generateEd25519KeyPair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyHex: string }
publicKeyHexOf(key: PublicKeyLike): string
toPublicKey(key: PublicKeyLike): KeyObject
toPrivateKey(key: PrivateKeyLike): KeyObject
signEd25519(message: string | Uint8Array, privateKey: PrivateKeyLike): string      // hex signature
verifyEd25519(message: string | Uint8Array, signatureHex: string, publicKey: PublicKeyLike): boolean
stableStringify(value: unknown): string   // canonical JSON (sorted keys, bigint as "<n>n")
```

## Ledger: `src/testnet/ledger.ts`

### Constructor

```ts
new UepLedger({
  networkId, domainId, connected, allowFaucet,
  snapshotSigningKeys?: PrivateKeyLike[],     // default: one ephemeral key (1-of-1); [] = verify-only node
  faucetSigningKey?: PrivateKeyLike | null,   // default: ephemeral key if allowFaucet; must differ from every snapshot key
})
```

- **Removed:** `snapshotAuthoritySecret`. Passing it throws `SNAPSHOT_SECRET_UNSUPPORTED`.
- `FAUCET_KEY_NOT_DISTINCT`: the faucet key equals a snapshot key. `SNAPSHOT_SIGNING_KEYS_DUPLICATE`: the same snapshot key is passed twice.
- `ledger.snapshotAuthorityPublicKeys(): string[]` and `ledger.faucetPublicKey(): string | undefined` return the public keys to hand to verifiers.
- `ledger.faucet(account, assetId, amount)` now also appends a signed `MintRecord` to `ledger.mints`. It throws `FAUCET_KEY_REQUIRED` without a faucet key and `FAUCET_AMOUNT_INVALID` for a non-positive or out-of-range amount.

### Snapshots (format version 3)

```ts
ledger.snapshot(): UepLedgerSnapshot          // signs with every snapshot key held; advances the chain
ledger.snapshotPayload()                      // next unsigned payload (does not advance)
ledger.lastCheckpoint(): { sequence, snapshotHash }
```

`UepLedgerSnapshot` adds `formatVersion: 3`, `sequence`, `prevSnapshotHash` (64 zeros for the first snapshot), `mints: MintRecord[]`, `snapshotHash` and `signatures: { publicKey, signature }[]`. **Removed:** `integrity` and the self-declared `supply`; supply is derived from the signed mints.

Module helpers:

```ts
snapshotHash(snapshot): string                              // SHA-256 over domain tag + canonical payload
checkpointOf(snapshot): SnapshotCheckpoint                  // { sequence, snapshotHash, txCount, txChainHash, mintCount, mintChainHash }
signSnapshot(snapshotOrPayload, privateKeys): UepLedgerSnapshot   // authority tooling: (re)sign
cosignSnapshot(snapshot, privateKey): UepLedgerSnapshot     // add one co-signature (k-of-n)
mintMessage(mintWithoutSignature): string                   // canonical message signed by the faucet key
GENESIS_SNAPSHOT_HASH, SNAPSHOT_FORMAT_VERSION (= 3)
```

**Removed:** `signSnapshotPayload()`.

### Restore

```ts
UepLedger.restore(snapshot, trust: SnapshotTrust, keys?: LedgerSigningKeys): UepLedger
UepLedger.restoreChain(snapshots: UepLedgerSnapshot[], trust: SnapshotTrust, keys?: LedgerSigningKeys): UepLedger

type SnapshotTrust = {
  authorities: PublicKeyLike[];        // n snapshot authority public keys
  threshold?: number;                  // k (default 1)
  faucetPublicKeys?: PublicKeyLike[];  // required if the snapshot has mints; must not overlap authorities
  previousSnapshotHash?: string;       // snapshot must directly follow this hash
  checkpoint?: SnapshotCheckpoint;     // snapshot must equal or extend this checkpoint
};
type LedgerSigningKeys = { snapshotSigningKeys?: PrivateKeyLike[]; faucetSigningKey?: PrivateKeyLike };
```

- Previously `restore(snapshot, snapshotAuthoritySecret)`.
- Verifiers pass only public keys. A ledger restored without `keys` cannot sign snapshots (`SNAPSHOT_SIGNING_KEY_REQUIRED`) or mint (`FAUCET_KEY_REQUIRED`). Supplied keys must belong to the trust anchors (`SNAPSHOT_SIGNING_KEY_NOT_TRUSTED`, `FAUCET_KEY_NOT_TRUSTED`).
- New errors:
  - `INVALID_SNAPSHOT_VERSION`: format 1 or 2 is no longer supported.
  - `INVALID_SNAPSHOT_TRUST`: bad or duplicate keys, a threshold out of range, or a faucet key that is also an authority.
  - `INVALID_SNAPSHOT_HASH`: `snapshotHash` does not match the content.
  - `INVALID_SNAPSHOT_SIGNATURE`: a listed authority's signature does not verify.
  - `INVALID_SNAPSHOT_THRESHOLD`: fewer than `k` distinct valid listed signers. Duplicates count once; unknown keys are ignored.
  - `INVALID_SNAPSHOT_CHAIN`: wrong predecessor, a sequence gap or reorder, a rollback behind the checkpoint, or a conflict with it.
  - `INVALID_SNAPSHOT_HISTORY`: the transaction or mint history diverges from the checkpoint prefix.
  - `INVALID_SNAPSHOT_MINT_KEY`: the snapshot has mints but no faucet key was supplied.
  - `INVALID_SNAPSHOT_MINT_SIGNATURE`: a mint is unsigned or signed by an untrusted key.
  - `INVALID_SNAPSHOT_MINT_SHAPE`, `INVALID_SNAPSHOT_MINT_NOTE`, `INVALID_SNAPSHOT_MINT_DUPLICATE`.
  - `INVALID_SNAPSHOT_UNMINTED_NOTE`: a note is neither a signed mint nor a transaction output.
  - All v0.4.2 `INVALID_SNAPSHOT_*` invariant errors still apply.

## Marketplace: `src/marketplace/marketplace.ts`, `src/marketplace/identity.ts`

### Configuration (new options)

```ts
new DigitalServicesMarketplace({
  ...,
  cancellationGraceMs?: number,                // default 120_000 (2 min)
  marketplaceId?: string,                      // signature domain, default "uep-marketplace-testnet"
  reservationTtlMs?: number,                   // default 600_000 (10 min), must be > 0
  maxActiveReservationsPerIdentity?: number,   // default 8
  reservationDeposit?: bigint, reservationDepositBps?: number,   // unchanged (default 1%, min 1 unit)
})
```

### Identities and balances (new)

```ts
registerIdentity(identityId: string, publicKey: PublicKeyLike): RegisteredIdentity   // first-come, immutable
isIdentityRegistered(identityId): boolean
registeredIdentity(identityId): RegisteredIdentity
creditAccount(identityId, asset, amount): bigint     // testnet funding rail; registered identities only
availableBalance(asset, identityId): bigint
lockedDeposit(asset, identityId): bigint
valueAccounting(asset): ValueAccounting              // credited == available + locked + held + fees + gas
```

Errors: `IDENTITY_NOT_REGISTERED`, `IDENTITY_ALREADY_REGISTERED`, `RESERVED_IDENTITY`, `IDENTITY_PUBLIC_KEY_INVALID`, `INVALID_CREDIT_AMOUNT`.

Client helpers (`identity.ts`): `createMarketplaceIdentity(id)`, `reservationMessage()`, `signReservation({ marketplaceId, listingId, buyerId, quantity, idempotencyKey, orderId?, gasQuoteId? }, privateKey)`, `cancellationMessage()` and `signCancellation({ marketplaceId, orderId, buyerId }, privateKey)`.

### Order lifecycle

```ts
reserve({ listingId, buyerId, quantity, idempotencyKey, signature, orderId?, gasQuote? }): ServiceOrder
acceptOrder(sameInput): ServiceOrder                    // alias of reserve()
assertReservationAuthorized(sameInput): void
fundOrder(orderId, amount /* = order.fundingDue */, idempotencyKey?): ServiceOrder
cancel(orderId, actorId, options?: string | { reason?: string; signature?: string }): ServiceOrder
expire(orderId, actorId): ServiceOrder                  // only after the TTL
reservationDepositFor(grossAmount, gasFee = 0n): bigint // capped at grossAmount + gasFee
```

- `acceptOrder`/`reserve` now **require** `idempotencyKey` and `signature`. The buyer must be registered, and the deposit is locked from `availableBalance` (`INSUFFICIENT_FUNDS_FOR_DEPOSIT`). Other errors: `RESERVATION_SIGNATURE_INVALID`, `IDEMPOTENCY_KEY_REQUIRED`, `RESERVATION_LIMIT_REACHED`, and `ORDER_ID_CONFLICT`, which replaces silently returning an existing order.
- A replayed signed request returns the same order. It never locks a second deposit.
- `fundOrder` amount is now `grossAmount + gasFee − reservationDeposit` (`order.fundingDue`), previously `grossAmount + gasFee + reservationDeposit`. It is debited from the buyer's balance (`INSUFFICIENT_FUNDS`). `heldAmount` is then `grossAmount + gasFee`.
- A buyer `cancel` requires `{ signature }` (`BUYER_SIGNATURE_REQUIRED`, `CANCELLATION_SIGNATURE_INVALID`). Within `cancellationGraceMs` of reservation the deposit is refunded; afterwards it is forfeited to the provider. Provider or authorized-admin cancellation refunds the buyer in full.
- Expiry: an unfunded reservation forfeits the deposit to the provider, and a funded undelivered order is refunded in full. `expire()` before the TTL throws `RESERVATION_NOT_EXPIRED`.
- At settlement the provider's net payout is credited to its `availableBalance`.
- `ServiceOrder` adds `fundingDue`, `depositLocked` and `depositOutcome` (`APPLIED_TO_PAYMENT` | `REFUNDED` | `FORFEITED_TO_PROVIDER`).
- `checkoutQuote()`: `buyerTotal` is now `grossAmount + gasFee` because the deposit is included. It adds `dueAtFunding` and `cancellationGraceMs`.

## IoT/M2M: `src/service/iot-m2m.ts`

```ts
requestService({ buyerId, listingId, machineId, quantity, idempotencyKey, authorization, requestId? })
hold(requestId)   // funds grossAmount + gasFee − reservationDeposit
```

`idempotencyKey` and `authorization` are now **required**. `authorization` is the buyer's `signReservation({ marketplaceId, listingId, buyerId, quantity, idempotencyKey }, privateKey)`, and the buyer must be a registered, funded marketplace identity.

## Test helpers: `src/marketplace/testkit.ts` (new)

`enrollIdentity`, `reserveAs`, `cancelAsBuyer` and `iotAuthorization` are for tests and simulations only.
