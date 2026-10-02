# Public API reference: changed signatures (v0.4.3 – v0.4.6)

This page lists the public signatures that changed in `0.4.6-public-iot-m2m`, `0.4.5-public-iot-m2m`, `0.4.4-public-iot-m2m` and `0.4.3-public-iot-m2m`, newest first. Everything else is unchanged; see the source for full types. Error codes are thrown as `Error(message)` where the message starts with the code. Ledger submit errors are returned as `{ error: { code, message } }`.

# v0.4.6

## Marketplace: `src/marketplace/marketplace.ts`

```ts
type CategoryServiceHooks = {
  settlementGuard?: (order: ServiceOrder) => void;   // now also gates a RELEASE dispute timeout
  consumedUnits?: (order: ServiceOrder) => bigint;   // new: units proven executed (clamped to [0, quantity])
};
ServiceOrder.disputeOutcome   // + "TIMEOUT_REFUND_UNVERIFIED"
ServiceOrder.capacityConsumed?: bigint   // units kept consumed when the order closed
ServiceOrder.capacityRestored?: bigint   // units returned to the listing (set exactly once)
SettlementRecord.categoryGuard?: "PASSED" | "TIMEOUT_REFUNDED" | "ARBITER_OVERRIDE"   // guarded categories only
SettlementRecord.capacityRestored?: bigint
capacityAccounting(listingId): CapacityAccounting
type CapacityAccounting = { listingId, capacity, available, reserved, consumed, conserved }
```

- **Dispute timeout (UEP-D04).**
  - With `disputeTimeoutOutcome: "RELEASE"`, `settle()` on a timed-out dispute pays the provider only if the category guard passes. The outcome is then `RELEASE`, with `disputeOutcome` `TIMEOUT_RELEASE` and `categoryGuard` `PASSED` for guarded categories.
  - Otherwise the order closes as `REFUND_BUYER`, with `disputeOutcome` `TIMEOUT_REFUND_UNVERIFIED` and `categoryGuard` `TIMEOUT_REFUNDED`.
  - A category is guarded if it is `IOT_M2M` or has a `settlementGuard` attached. An IoT listing without an attached IoT service always fails the guard.
- **Guarded release paths:** `settle()` on DELIVERED orders, the buyer's dispute withdrawal, and the RELEASE timeout.
- **Arbiter resolution.** `resolveDispute()` RELEASE / SPLIT is not blocked by the guard (arbiter trust). Its record carries `categoryGuard` `PASSED` or `ARBITER_OVERRIDE` for guarded categories. REFUND_BUYER never carries it.
- **Capacity (UEP-D05).** When an order closes, capacity returns exactly once:
  - cancel / expire: the full quantity;
  - full release: 0;
  - refund / split: `quantity − max(consumedUnits evidence, ceil(providerAmount × quantity / gross))`.
- The capacity check runs before any value moves. Errors: `CAPACITY_ALREADY_RESTORED`, `CAPACITY_ACCOUNTING_INVALID`. `available` never exceeds `capacity`.
- `capacityAccounting()` is public listing data: open orders count as `reserved`, closed orders as `consumed` (`capacityConsumed`).

## IoT/M2M: `src/service/iot-m2m.ts`

- The attached hooks are `settlementGuard` (now also used by the RELEASE timeout) and `consumedUnits`.
- `consumedUnits` returns the `unitsDelivered` of the verification bound to the order's delivered report, or 0 if there is none.
- The guard additionally requires `verification.unitsDelivered === order.quantity` (`IOT_USAGE_SHORTFALL`).

# v0.4.5

## Key-derived accounts: `src/core/spend-key.ts`

```ts
ACCOUNT_ID_VERSION = 0x02
deriveSpendKey(secret, salt): { privateKey, publicKeyHex }   // unchanged (deterministic Ed25519)
accountIdFromSpendKey(publicKey): Fr        // 0x02 || SHA-256("UEP-ACCOUNT-KEY-v2\n" || raw32(publicKey))[0..31]
accountIdFromSecrets(secret, salt): Fr      // = accountIdFromSpendKey(deriveSpendKey(secret, salt).publicKeyHex)
isKeyDerivedAccountId(id): boolean          // leading byte 0x02
spendKeyHash(publicKey), accountIdFromKeyHash(hash31), keyHashOfAccountId(id), rawEd25519PublicKey(publicKey)
spendKeyMatchesAccount(publicKey, accountId): boolean
senderAuthFailure(tx): "MISSING" | "OWNER_KEY" | "SIGNATURE" | undefined
verifySenderAuth(tx): boolean               // was verifySenderAuth(tx, registeredPublicKey)
```

**Removed:** `SpendKeyRegistration`, `spendKeyRegistrationMessage()`, `verifySpendKeyRegistration()`.

- `IdentitySecrets.accountId` is now key-derived. The new `IdentitySecrets.spendPublicKey` is the key it commits to.
- `verifyOwnership(secret, salt, id)` compares against `accountIdFromSecrets`.
- `hAccount()` is still the state-tree leaf-key hash; it is no longer an identity derivation.

## Addresses: `src/core/address.ts` (UEP-ADDR-002)

```ts
ADDRESS_VERSION = 2; ADDRESS_HRP = "uep"
encodeAccountAddress(networkId, accountId): string            // Bech32m("uep", 0x02 || networkTag(4) || keyHash(31)); 68 chars
addressFromSpendKey(networkId, publicKey): string
decodeAccountAddress(address, expectedNetworkId?): { ok: true, version: 2, networkTag, accountId } | { ok: false, code, message }
parseAccountAddress(address, networkId): Fr                   // throws "<code>: message"
addressNetworkTag(networkId): string                          // SHA-256("UEP-ADDR-NETWORK-v2\n" || networkId)[0..4], hex
isValidBech32m(s), bech32mEncode(hrp, bytes)                  // BIP-350 helpers
UepAddressV2: AddressEncoder                                  // encode / decode(address, expectedNetworkId?)
UepAddressV1                                                  // deprecated: encode throws ADDRESS_LEGACY_V1, decode returns null
```

Decode error codes:

| Code | Meaning |
|---|---|
| `ADDRESS_CHECKSUM` | Bech32m checksum mismatch (typo, substitution, transposition). |
| `ADDRESS_VERSION` | Unsupported version byte, or encoding a non-key-derived id. |
| `ADDRESS_NETWORK` | Network tag of another network. |
| `ADDRESS_HRP` | Prefix other than `uep`. |
| `ADDRESS_LENGTH` | Wrong overall or payload length. |
| `ADDRESS_FORMAT` | Mixed case, invalid character, or missing separator. |
| `ADDRESS_LEGACY_V1` | `uep:<network>:<hex>` addresses from v0.4.4 and earlier. |

`DecodedAddress` is now `{ version, networkTag, accountId }`; `networkId` can no longer be read back from an address, only checked against it.

## Ledger: `src/testnet/ledger.ts`

```ts
ledger.addressOf(account): string                      // v2 address on this ledger's network
ledger.resolveAccount(accountOrAddress): Fr            // v2 address string or key-derived Fr; throws ADDRESS_*
ledger.faucet(accountOrAddress, asset, amount)         // throws FAUCET_ACCOUNT_INVALID for legacy / invalid accounts
ledger.prepareSpend(secrets, recipientOrAddress, asset, amount)   // INVALID_ADDRESS for bad addresses
```

**Removed:** `ledger.registerSpendKey()`, `ledger.spendKeyOf()` and `ledger.spendKeys`.

- Spends are verified without a registry. `senderAuth.publicKey` must hash to `senderId` and to every input note's owner (`OWNER_KEY`), and must have signed the envelope (`SENDER_AUTH`).
- Sender and recipient must be key-derived ids (`INVALID_PARTICIPANTS` in `checkSpendShape`).
- New `SubmitError` codes: `OWNER_KEY`, `INVALID_ADDRESS`.

### Snapshots (format version 5)

`SNAPSHOT_FORMAT_VERSION = 5`. The `spendKeys` field is removed, and a snapshot that carries one is rejected (`INVALID_SNAPSHOT_SPEND_KEY`). v3/v4 snapshots are rejected (`INVALID_SNAPSHOT_VERSION`).

New restore checks:

- `INVALID_SNAPSHOT_NOTE_OWNER`: a note owner is not a key-derived account id.
- `INVALID_SNAPSHOT_OWNER_KEY`: a committed spend's revealed key does not hash to its sender or input-note owner.
- `INVALID_SNAPSHOT_TX_SENDER`: the signature is missing or does not verify.
- `INVALID_SNAPSHOT_PENDING: OWNER_KEY`: the same rule applied to pending entries.

## Marketplace: `src/marketplace/marketplace.ts`

```ts
new DigitalServicesMarketplace({
  ...,
  ledgerNetworkId?: string,                       // network of address-named identities (default "uep-testnet-1")
  reservationDeposit?: bigint,                    // now >= MIN_RESERVATION_DEPOSIT (1n) ...
  testOnlyAllowZeroReservationDeposit?: boolean,  // ... unless this TEST-ONLY flag permits exactly 0n
})
marketplace.ledgerAccountOf(identityId): Fr | undefined
```

- `registerIdentity(identityId, publicKey)`: an id that is a v2 address (`uep1…`) must be canonical lowercase for `ledgerNetworkId`, and the key must be the one the address commits to. Errors: `IDENTITY_ADDRESS_INVALID: <ADDRESS_CODE>` and `IDENTITY_ADDRESS_KEY_MISMATCH`. Legacy `uep:<network>:<hex>` ids are refused. Plain names are unchanged.
- `reservationDeposit` from 0 to below 1 throws `RESERVATION_DEPOSIT_BELOW_MINIMUM` unless `testOnlyAllowZeroReservationDeposit: true` (UEP-D03). Negative values still throw `INVALID_RESERVATION_LIMIT`.
- `fundOrder(orderId, amount, auth)` is unchanged since v0.4.4. Only the buyer's `fund` signature is accepted: unsigned calls get `ACTOR_SIGNATURE_REQUIRED`, other parties `ORDER_ACCESS_FORBIDDEN`, wrong keys `ACTOR_SIGNATURE_INVALID` (UEP-D02).
- `src/marketplace/testkit.ts`: `enrollAccountIdentity(m, secrets, credit?)` registers a ledger identity under its address with its spend key.

IoT/M2M providers are marketplace identities, so the same address rule applies to them. IoT signatures are unchanged.

# v0.4.4

The v0.4.4 signatures below are superseded where the v0.4.5 section above says so. In particular the spend-key registry (`registerSpendKey`, `spendKeyOf`, `spendKeys`) is removed and the snapshot format is 5.

## Fees: `src/core/fee.ts`, `src/marketplace/economy.ts`

```ts
creatorFee(amount): bigint                 // 0 for 0; else max(MIN_PROTOCOL_FEE = 1, floor(amount * 0.1%))
calculateMarketplaceFee(gross, bps = 300)  // 0 for 0 or bps = 0; else max(MIN_MARKETPLACE_FEE = 1, floor(gross * bps / 10_000)), capped at gross
```

The documented rates (0.1% protocol, 3% Marketplace) are unchanged above the floor (1,000 units and about 34 units respectively). Envelopes with `fee = 0` on a positive amount are now rejected.

## Sender spend keys: `src/core/spend-key.ts` (new)

```ts
deriveSpendKey(secret, salt): { privateKey, publicKeyHex }        // deterministic Ed25519 key, never leaves the holder
senderAuthMessage(tx): string                                      // "UEP-TX-SENDER-v1" over networkId, domainId, txId, senderId, transactionCommitment
signSenderAuth(tx, secret, salt): { publicKey, signature }
verifySenderAuth(tx, registeredPublicKey): boolean
spendKeyRegistrationMessage(networkId, accountHex), verifySpendKeyRegistration(networkId, reg)
```

## Note-commitment tree: `src/core/note-tree.ts` (new)

```ts
class NoteCommitmentTree {          // depth 32, append-only, keeps every historical root
  append(commitment): number; root(): Fr; size: number; indexOf(commitment)
  prove(commitment): NoteMembershipProof          // { leafIndex, root, siblings[32] } (hex strings)
  verify(commitment, proof, maxAnchorSize?): boolean   // proof root must be a root this tree has had
  sizeAtRoot(rootHex): number | undefined
}
verifyNoteMembership(commitment, proof): boolean  // stateless: links commitment to proof.root
```

## Ledger: `src/testnet/ledger.ts`

```ts
new UepLedger({ ..., maxPendingTransactions?: number })   // default 1024, 1..100_000 (INVALID_MAX_PENDING_TRANSACTIONS)
ledger.registerSpendKey(secrets): SpendKeyRegistration      // idempotent; proves account control
ledger.spendKeyOf(account): string | undefined
ledger.noteCommitmentRoot(): Fr
ledger.noteByCommitment(commitment): Note | undefined
ledger.enqueuePending(tx): SubmitResult                     // validated, bounded, de-duplicated
ledger.queueConflict(tx): SubmitResult                      // was void; now = enqueuePending(tx)
```

- `prepareSpend()` registers the sender's spend key and attaches `tx.senderAuth` and `tx.inputMembership`.
- `submit()` additionally requires a valid membership proof (`MEMBERSHIP_PROOF`) and a valid sender signature by the registered key (`SENDER_AUTH`), also when `requireProof` is disabled. Outputs that already exist are refused (`OUTPUT_BINDING`).
- Offline `submit()` validates before queueing: it returns the validation error, or `NOT_CONNECTED` with a "queued" message.
- Pending validation requires: a registered sender key and valid `senderAuth`; canonical, unspent local input notes whose transported fields match (`NOTE_NOT_MEMBER`, `DOUBLE_SPEND`, `NOTE_OPENING`); `checkSpendShape()` on the canonical inputs; a valid membership proof. Full queue: `PENDING_FULL`; duplicate: `REPLAY`.
- `reconcilePending()` also flags spends sharing an input note as `inConflict`. It still never settles.
- New `SubmitError` codes: `SENDER_AUTH`, `MEMBERSHIP_PROOF`, `PENDING_FULL`.
- `UepTransaction` gains optional `senderAuth` and `inputMembership` (serialized as-is).

### Snapshots (format version 4)

The snapshot adds `noteRoot`, `noteCount`, `spendKeys` and `maxPendingTransactions`. Pending entries that no longer validate are not exported. `SNAPSHOT_FORMAT_VERSION = 4`; v3 snapshots are rejected (`INVALID_SNAPSHOT_VERSION`).

New restore errors:

- `INVALID_SNAPSHOT_NOTE_ROOT`: the rebuilt note tree does not match `noteRoot` / `noteCount`.
- `INVALID_SNAPSHOT_TX_MEMBERSHIP`: a committed spend's proof is missing, wrong, or anchored at a root that does not predate its outputs.
- `INVALID_SNAPSHOT_TX_SENDER`: a committed spend is not signed by the registered spend key.
- `INVALID_SNAPSHOT_SPEND_KEY`: a malformed, duplicate or unproven key registration.
- `INVALID_SNAPSHOT_PENDING`: an over-bound or duplicate queue, or a pending entry that fails validation (the message carries its code).

## Marketplace: `src/marketplace/marketplace.ts`, `src/marketplace/identity.ts`

Every call that reads or changes an order now takes an **`ActorAuth`** instead of an identity string:

```ts
type ActorAuth = { actorId: string; signature: string; issuedAt?: number };
actionMessage({ marketplaceId, action, actorId, target, details }): string   // domain "UEP-MARKETPLACE-ACTION-v1"
signAction({ marketplaceId, action, actorId, target, details }, privateKey): ActorAuth
listingTerms(listingInput), disputeReasonHash(reason)
```

Registered identities sign with their registered key. `adminIdentity` signs with `adminPublicKey` and the arbiter with `settlementArbiterPublicKey`. A plain string throws `ACTOR_SIGNATURE_REQUIRED`; a wrong key throws `ACTOR_SIGNATURE_INVALID`.

| Call (v0.4.4) | action / target / details | Allowed actors |
|---|---|---|
| `publishListing(input, auth)` | `publish` / `input.listingId ?? ""` / `listingTerms(input)` | the registered provider |
| `fundOrder(orderId, amount, auth, idem?)` | `fund` / orderId / `{ amount }` | buyer |
| `deliver(orderId, auth, bytes, idem?)`, `deliverWithExpectedHash(orderId, auth, bytes, hash, idem?)` | `deliver` / orderId / `{ deliveryHash }` | provider |
| `settle(orderId, auth)` | `settle` / orderId | buyer; provider after `deliveryDisputeWindowMs` without a dispute; arbiter. Never the admin |
| `openDispute(orderId, auth, reason)` | `dispute` / orderId / `{ reasonHash }` | buyer, within the window, arbiter configured |
| `resolveDispute(orderId, auth, { outcome, providerAmount? })` | `resolve` / orderId / `{ outcome, providerAmount }` | arbiter |
| `refundBuyer(orderId, auth)` | `refund` / orderId | provider |
| `cancel(orderId, auth, reason?)` | `cancel` / orderId | buyer, provider, admin |
| `expire(orderId, auth)` | `expire` / orderId | buyer, provider, admin |
| `getOrder(orderId, auth)` | `read` / orderId / `{ issuedAt }` | buyer, provider, admin; arbiter once disputed |
| `listOrders(auth)`, `listOrdersPage(offset, limit, auth)` | `list` / `"orders"` / `{ issuedAt }` | own orders; admin sees all |
| `recordSellerReview({ orderId, rating }, auth)` | `review` / orderId / `{ rating }` | buyer |

- Read and list authorizations must carry `issuedAt` within `readAuthorizationTtlMs` (default 5 min) of the marketplace clock (`ACTOR_AUTH_ISSUED_AT_REQUIRED`, `ACTOR_AUTH_EXPIRED`). `clock()` exposes that clock.
- **Disputes.** `OrderStatus` adds `DISPUTED` and `REFUNDED`. Outcomes:
  - `RELEASE`: normal settlement.
  - `REFUND_BUYER`: gross + gas back to the buyer; the paymaster sponsorship is released; no fee.
  - `SPLIT`: `0 < providerAmount < gross`. The provider gets `providerAmount − fee(providerAmount)`, the treasury `fee(providerAmount)`, gas is captured, and the buyer gets `gross − providerAmount`. `0` → refund, `gross` → release.
  - A buyer `settle()` on a disputed order withdraws the dispute.
  - After `disputeResolutionWindowMs` (default 7 days) any party's `settle()` applies `disputeTimeoutOutcome` (default `REFUND_BUYER`).
  - `SettlementRecord` adds `outcome` and `buyerRefund`. `ServiceOrder` adds `deliveredAt`, `disputedAt`, `disputeReasonHash`, `disputeDeadline`, `disputeOutcome` and `buyerRefund`.
- Errors: `DISPUTE_NOT_AUTHORIZED`, `DISPUTE_ARBITER_NOT_CONFIGURED`, `ORDER_NOT_DISPUTABLE`, `DISPUTE_WINDOW_CLOSED`, `DISPUTE_PENDING`, `DISPUTE_NOT_OPEN`, `DISPUTE_RESOLUTION_NOT_AUTHORIZED`, `DISPUTE_OUTCOME_INVALID`, `DISPUTE_SPLIT_INVALID`, `REFUND_NOT_AUTHORIZED`, `ORDER_NOT_REFUNDABLE`.
- **Configuration:**
  - `adminPublicKey`: without it no admin action is possible (`ADMIN_NOT_CONFIGURED`). `adminAuthorizer` is an optional extra gate.
  - `settlementArbiterPublicKey`: required with `settlementArbiterId` (`ARBITER_PUBLIC_KEY_REQUIRED`).
  - `disputeResolutionWindowMs`, `disputeTimeoutOutcome`, `readAuthorizationTtlMs`.
- **Reserved identities:** `"marketplace-admin"`, `"marketplace-system"` (`RESERVED_IDENTITIES`), the admin id and the arbiter id.
- **Other new members:**
  - `authenticateActor(auth, action, target, details)`: verification only.
  - `authorityPublicKeys()`, `orderCount()`.
  - `attachCategoryService(category, { settlementGuard })`: once per category. It returns a read capability limited to that category's orders, and its guard runs on the normal release paths.
  - `IOT_M2M` orders cannot be released normally without an attached guard (`IOT_SETTLEMENT_GUARD_REQUIRED`).
- `cancellationMessage()` / `signCancellation()` now produce a `cancel` action signature. Pass it as `{ actorId: buyerId, signature }`.
- `MARKETPLACE_VERSION = "0.4"`.

## IoT/M2M: `src/service/iot-m2m.ts`

```ts
registerProvider({ providerId, displayName }, auth)            // registered marketplace identity; "iot-provider-register" / providerId / { displayName }
registerMachine({ machineId, providerId, serviceType, model, endpointRef, publicKeyHex }, auth)   // publicKeyHex required; "iot-machine-register" / machineId / iotMachineTerms(input)
deactivateProvider(providerId, adminAuth)                      // "iot-provider-deactivate"
deactivateMachine(machineId, adminOrProviderAuth)              // "iot-machine-deactivate"
holdAmount(requestId): bigint; hold(requestId, buyerFundAuth)
simulateExecution(requestId, measurements, observedAt?, machinePrivateKey, unitsDelivered?)   // signer required
deliverTelemetry(requestId, telemetry, providerDeliverAuth)    // deliveryHash = iotTelemetryDeliveryHash(telemetry)
verifyTelemetry(requestId, telemetry): IoTVerification         // adds unitsDelivered, fullyDelivered, deliveryHash; authentication is always "ED25519"
settle(requestId, settleAuth); serviceStatus(requestId, readAuth)
getRequest / getContract / getTelemetry(id, readAuth); orderIdOf(requestId)
```

- The unsigned `SIMULATED` mode is removed: machines without a key cannot be registered, and unsigned or wrong-key telemetry is rejected (`IOT_TELEMETRY_SIGNATURE_INVALID`, `IOT_SIGNED_TELEMETRY_REQUIRED`).
- Sequence and nonce replay checks are unchanged.
- `IoTTelemetry` adds `unitsDelivered` (it is part of the signed payload). Verification only accepts the report delivered to the order (`IOT_TELEMETRY_NOT_DELIVERED`).
- The marketplace releases an IoT order through `settle()` only with verified telemetry for that delivery reporting the full quantity: `IOT_VERIFICATION_REQUIRED`, `IOT_VERIFIED_TELEMETRY_REQUIRED`, `IOT_USAGE_SHORTFALL`. A shortfall goes to a dispute. `serviceStatus().verifiedUsageAmount` is the provider share for a SPLIT.
- `IOT_M2M_VERSION = "0.3"`.

## Test helpers

- `src/marketplace/testkit.ts`: `createTestAuthority`, `act`, `readAuth`, `listAuth`, `publishAs`, `fund`, `deliver`, `deliverWithExpectedHash`, `settle`, `getOrder`, `listOrders`, `cancel`, `expire`, `review`, `disputeAs`, `resolveAs`, `refundAs`, plus the v0.4.3 helpers.
- `src/service/iot-testkit.ts` (new): `registerProviderAs`, `registerMachineAs`, `requestAs`, `holdAs`, `simulateAs`, `deliverTelemetryAs`, `settleIoTAs`, `statusAs`.

These helpers are for tests and simulations only.

# v0.4.3

The v0.4.3 signatures below are superseded where the v0.4.4 section above says so (for example `fundOrder`, `cancel`, `expire`, `getOrder` and the IoT calls now take an `ActorAuth`).

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
