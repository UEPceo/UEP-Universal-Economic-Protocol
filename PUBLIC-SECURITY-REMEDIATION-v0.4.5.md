# UEP Public Marketplace + IoT/M2M — v0.4.5 Remediation

This document covers:
- how v0.4.5 replaces the spend-key registry, which v0.4.4 left partially addressed, with key-derived accounts;
- two items from the external review of v0.4.3 (UEP-D02, UEP-D03).

Status labels are deliberately conservative. **Addressed** means the property is enforced by the local reference ledger / Marketplace and covered by a negative test. **Partially addressed** means a mitigation exists but the full property is not yet met.

Previous reports: [`v0.4.4`](./PUBLIC-SECURITY-REMEDIATION-v0.4.4.md), [`v0.4.3`](./PUBLIC-SECURITY-REMEDIATION-v0.4.3.md), [`v0.4.2`](./PUBLIC-SECURITY-REMEDIATION-v0.4.2.md), [`v0.4.1`](./PUBLIC-SECURITY-REMEDIATION-v0.4.1.md). Changed signatures: [`docs/API.md`](./docs/API.md).

## Findings addressed

1. **Spend-key registry trust (open item of v0.4.4)**: addressed by key-derived accounts.
   - *Account ids.* Each account id now commits to the owner's Ed25519 spend public key through a domain-separated hash with a version byte. Every note owner is such an id.
   - *Spends.* A spend reveals the public key and signs the envelope.
   - *Verification.* `submit()`, the pending queue and `restore()` all check, without the sender's secret and without any registry, that the key hashes to the sender and to every input note's owner and that the signature verifies.
   - *Registry removed.* The v0.4.4 spend-key registry is gone from the ledger and from snapshots; a snapshot that still carries one is refused.
   - *Restore checks.* Every note owner must be a key-derived id, and every committed spend must satisfy the key/owner binding. Snapshot format 5 is required.
   - *Tests:*
     - a note spent with a key its owner's address does not commit to (as the claimed sender, and as a different sender);
     - an arbitrary unrelated public key;
     - a forged registry entry on a live node, in a signed snapshot, and as a signed pending entry;
     - restore with a swapped spend key, a stripped signature and a non-key-derived note owner;
     - rejection of formats 3 and 4.
2. **Address format (UEP-ADDR-002)**: addressed.
   - *Format.* Addresses are Bech32m strings (BIP-350 checksum) with a version byte, a 4-byte network tag and the 31-byte key hash.
   - *Errors.* Decoding distinguishes checksum, version, network, prefix, length, format and legacy-v1 errors. The ledger accepts address strings in `faucet()` and `prepareSpend()`, and refuses legacy or non-key-derived accounts.
   - *Tests:* single-character substitutions, a transposition, version and length errors under a valid checksum, a foreign prefix, a wrong network, mixed case, legacy v1 strings and the BIP-350 reference vectors.
3. **Marketplace and IoT identity consistency**: addressed for identities that map to ledger accounts.
   - A marketplace (and therefore IoT provider) identity may be named by its ledger v2 address. It must then register exactly the spend key the address commits to, in canonical form, for the configured ledger network.
   - Plain identity names keep their previous behaviour.
   - *Tests:* mismatched key; malformed, non-canonical, wrong-network and legacy address ids; a full address-named buyer/provider flow with value conservation, including an IoT order.
4. **Unsigned order funding (UEP-D02, v0.4.3 report)**: confirmed addressed since v0.4.4, and a dedicated test was added.
   - `fundOrder()` accepts only the buyer's signed `fund` action.
   - Unsigned calls, other registered identities, the provider and wrong-key signatures are refused, and the buyer's balance does not move.
5. **Zero reservation deposit (UEP-D03, v0.4.3 report; listed as D02 in the v0.4.4 documents)**: addressed.
   - A configured deposit below 1 unit is refused at construction.
   - Exactly zero is only possible with the explicitly named test-only flag `testOnlyAllowZeroReservationDeposit`.
   - The proportional default keeps its 1-unit minimum.
   - *Tests:* zero refused with and without a false flag; negative values refused; the 1-unit floor for the default and `bps = 0`; reservation without funds refused; the test-only flag.

## Findings partially addressed

- **Development MAC and mutable `requireProof` (UEP-A11, UEP-A12)**: unchanged since v0.4.4.
  - Ownership is now publicly verifiable through the key binding, and the sender signature is always required.
  - The nullifier derivation is still only checked by the development MAC, which requires the sender's secret. Double spends remain prevented by the canonical spent-note set and the nullifier set of the receiving ledger.

## Residual trust model

The snapshot-authority, faucet-key, arbiter and machine-key trust model of v0.4.4 is unchanged. In addition:

- The spend key is derived deterministically from the account credentials. Anyone holding the mnemonic controls the account. There is no key rotation: a new key means a new account and address.
- Account ids carry a 248-bit key hash. Collisions between attacker-controlled keys give no advantage. Finding a second key for someone else's account requires a second-preimage attack on SHA-256.
- An address's network tag prevents accidental cross-network use. It is not a security boundary between networks that share identities.
- Address-named marketplace identities prove only key consistency with the ledger account, not that the account holds funds. Marketplace balances are still credited through the testnet `creditAccount()` stub.

## Not addressed in this release

- ZK witness range checks (UEP-A22). The conceptual witness contract now expects the key-derived account id; a future circuit must prove the key binding or the signature in-circuit.
- Self-service identity registration (not Sybil resistance).
- Key rotation and revocation.
- Lower-priority items (UEP-A17–A25) not listed above.

## Deliberate protocol boundary

The public transaction envelope carries a single nullifier, so public testnet spends use exactly one input note (UEP-C04).

## Migration note

v1 addresses (`uep:<network>:<hex>`) and the account ids behind them (`H(secret, salt)`) are **invalid** from v0.4.5 on. The same mnemonic derives a new key-derived account and address. Testnet state, snapshots (formats 3 and 4) and wallet vaults created with v0.4.4 or earlier must be re-created; legacy vaults report `LEGACY_VAULT`. This is a testnet: no balances are migrated.

## Compatibility notes

- *Identities.* Every identity's account id changes, and `IdentitySecrets` adds `spendPublicKey`.
- *Ledger.* `registerSpendKey()`, `spendKeyOf()` and the snapshot `spendKeys` field are removed. `faucet()` and `prepareSpend()` accept v2 addresses and refuse non-key-derived accounts. New submit codes: `OWNER_KEY`, `INVALID_ADDRESS`.
- *Addresses.* `UepAddressV1.encode()` throws, `decode()` returns null, and `DecodedAddress` has a new shape. `verifySenderAuth(tx)` takes one argument.
- *Snapshots.* Format 5 is required.
- *Marketplace.* `reservationDeposit: 0n` requires the test-only flag. Address-shaped identity ids are validated (`ledgerNetworkId`).

## Verification

- `npm test`: protocol suite 67/67 and Marketplace/IoT suite 81/81 PASS (Node 22 and Node 24).
- `npm run test:scale`: 3/3 PASS; `npm run test:iot`: 23/23 PASS.
- `npm run smoke:testnet` and `npm run quickstart` (v2 addresses): PASS.
- `npm run simulate:20k`: 20,000 signed, funded, delivered and settled main-flow operations with 0 errors and value conserved.

## Remaining production limitations

This repository is a public local testnet implementation. It does not claim production consensus, production ZK proving keys/ceremony, production key custody or rotation, hardware-backed machine attestation, an independent dispute-resolution service, or a production custody/payment rail.
