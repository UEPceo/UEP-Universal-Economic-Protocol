# Public Threat Model

This threat model covers the **testnet reference path**: `src/core`, `src/testnet`, `src/identity`, `src/marketplace`, the IoT/M2M service (`src/service/iot-m2m*`) and `src/network`. The research labs (`src/lab`, `src/agent`, the service/API lab in `src/service`, `uep-core/`) are experimental and outside this model; they carry no security claim (see [`LABS.md`](./LABS.md)). Per-release findings and their status are in the `PUBLIC-SECURITY-REMEDIATION-v0.4.x.md` files.

## Assets to protect

- transaction integrity;
- ownership binding;
- nullifier uniqueness;
- balance conservation within the reference state machine;
- note existence (note-commitment tree root) and the pending queue;
- Marketplace order state and order confidentiality between users;
- IoT/M2M usage evidence (machine telemetry);
- Marketplace Treasury accounting;
- Paymaster reserve accounting;
- reproducibility and deterministic serialization.

## Adversaries considered by the public tests

### Transaction attacker

Attempts to modify amount, asset, owner, commitment or transaction identifiers.

### Replay attacker

Attempts to submit the same transaction or spend the same nullifier twice.

### Marketplace attacker

Attempts duplicate settlement, unauthorized order actions, capacity exhaustion or
delivery manipulation.

### Accounting attacker

Attempts to bypass or duplicate Marketplace fees, Paymaster reservations or
Treasury allocation. Since v0.5.0 the Paymaster caps the open sponsorships per
actor (count and share of the budget) and per order, and expires its own
reservations, so one actor cannot lock the sponsorship budget.

### API caller (service/API lab)

Calls the HTTP/service API without a valid actor signature, or with a valid
signature but without the right role. Since v0.5.0 the API fails closed:
Marketplace and IoT calls need the signed actor headers (`x-uep-actor-id`,
`x-uep-signature`, and `x-uep-issued-at` for reads) and return 401 or 403; the
caller-id header is ignored; the treasury read needs an administrator
signature; `/v1/objects*` needs a token outside loopback; CORS is off unless
origins are configured.

### Queue injector

Attempts to place spends in another node's pending queue that are not signed by
the sender's spend key (since v0.4.5, the key its account id commits to), consume notes that do not exist or are already
spent, or flood the queue. Since v0.4.4 every entry is validated at entry and on
restore, and the queue is bounded.

### Address and key-substitution attacker

Attempts to spend a note with a key that the owner's address does not commit to. Other attempts in this class:

- planting a forged key-registry entry;
- injecting a mismatched key into signed history or the pending queue;
- using a mistyped, legacy or other-network address;
- registering a marketplace identity under someone else's address.

### Dispute and order-access attacker

Attempts to read or change another user's order, to impersonate a provider, the
admin or the arbiter, to open or resolve a dispute on an order it is not a party
to, or to extract more than the escrowed value through a dispute outcome.

### Telemetry forger

Attempts to settle an IoT/M2M order with unsigned, foreign-key, replayed or
inflated machine telemetry, or with telemetry that was not delivered for that
order.

### Snapshot forger

Attempts to restore a snapshot that was not signed by enough snapshot authorities,
replays or reorders an older signed snapshot, rewrites history behind a known
checkpoint, or adds issuance that the dedicated faucet key did not sign.

### Reservation griefer

Attempts to lock Marketplace capacity without funds, with an unregistered or
impersonated identity, or beyond the per-identity concurrency limit.
Since v0.5.0 unfunded reservations also cannot fill an attester set's
evidence cap: only HELD, DELIVERED or DISPUTED orders count against it.

## Residual trust (testnet)

Whoever holds the snapshot authority private keys controls what their own node
signs, and whoever holds the faucet key controls testnet issuance on that node.
Ed25519 signatures, the k-of-n threshold, the hash chain and checkpoints make
tampering by anyone else detectable and keep the snapshot and mint roles
separate. They do not make a key holder honest. This is the local testnet trust
model, not production consensus or production key custody.

Since v0.4.4 the following are also trusted parties of the testnet:

- **Spend-key registry (removed in v0.4.5).** v0.4.4 trusted a spend-key registry delivered in signed snapshots. Since v0.4.5 account ids commit to the spend key, and spends reveal the key and sign. Any replica can check ownership on its own, so there is no registry left to trust.
- **Settlement arbiter.** It decides disputed outcomes within the escrowed value; it cannot create value. Since v0.4.6 its explicit release of a guarded (e.g. IoT) order is not blocked by the category guard, but the settlement record shows whether the guard passed (`categoryGuard`). Unattended timeouts never bypass the guard.
- **Machine keys.** A machine key proves who signed the telemetry, not that the physical service happened. A compromised or dishonest machine can still report false usage.

Since v0.5.0 time is block height (ADR 0002), which adds one more trusted party:

- **Single-node operator as time authority.** The operator of the single-node testnet decides when the height advances. The height producer (`src/service/height-producer.ts`) seals one block per 5 s of real time and never runs ahead of the clock, but the operator controls the process and can call `advanceHeight(n)` directly. Doing so is operator abuse: a provider could settle without the buyer's 24 h dispute window, and a MARS reservation or a 7-day dispute window could expire at once. Nobody else can move the height, and the height never goes backwards. This is the same trust the operator already has to order or censor transactions. A multi-node network needs a block-validation rule with a minimum spacing between blocks before heights can be trusted across operators.
- **Attester sets (configuration).** The operator registers attester sets. A set names its source and its attesters' keys; two sets for the same source with a common attester are refused, and only funded orders count against a set's cap. Evidence itself is phase 2.3 and certifies publication, not truth (`docs/EVIDENCE.md`).

## Out of scope

The public repository does not claim to solve:

- arbitrary Byzantine distributed consensus;
- global network finality;
- production key custody;
- compromised operating systems;
- compromised random-number generators outside the reference implementation;
- physical resource delivery;
- regulatory compliance;
- production payment-rail fraud;
- interplanetary double-spend under real communication partitions;
- the soundness of the research ZK circuit or the safety of the lab consensus experiments.

## Security principle

A test is evidence for one property. It is not evidence that all properties hold.
New security claims should therefore come with an explicit invariant and a
reproducible negative test whenever practical.
