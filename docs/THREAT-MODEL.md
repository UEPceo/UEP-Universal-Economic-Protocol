# Public Threat Model

## Assets to protect

- transaction integrity;
- ownership binding;
- nullifier uniqueness;
- balance conservation within the reference state machine;
- Marketplace order state;
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
