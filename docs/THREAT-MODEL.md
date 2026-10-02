# Public Threat Model

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
Treasury allocation.

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

## Residual trust (testnet)

Whoever holds the snapshot authority private keys controls what their own node
signs, and whoever holds the faucet key controls testnet issuance on that node.
Ed25519 signatures, the k-of-n threshold, the hash chain and checkpoints make
tampering by anyone else detectable and keep the snapshot and mint roles
separate. They do not make a key holder honest. This is the local testnet trust
model, not production consensus or production key custody.

Since v0.4.4 the following are also trusted parties of the testnet:

- **Spend-key registry (removed in v0.4.5).** v0.4.4 trusted a spend-key registry delivered in signed snapshots. Since v0.4.5 account ids commit to the spend key, and spends reveal the key and sign. Any replica can check ownership on its own, so there is no registry left to trust.
- **Settlement arbiter.** It decides disputed outcomes within the escrowed value; it cannot create value.
- **Machine keys.** A machine key proves who signed the telemetry, not that the physical service happened. A compromised or dishonest machine can still report false usage.

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
- interplanetary double-spend under real communication partitions.

## Security principle

A test is evidence for one property. It is not evidence that all properties hold.
New security claims should therefore come with an explicit invariant and a
reproducible negative test whenever practical.
