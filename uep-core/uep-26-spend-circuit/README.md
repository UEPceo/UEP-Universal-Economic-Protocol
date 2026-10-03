# UEP Spend Circuit (UEP-27.2)

**Proof-system hardening. Test keys only — no production ceremony.**

## Freeze

| | |
|---|---|
| Tag | `UEP-27-SPEND-POSEIDON-D32-v4-assetkey` |
| Constraints | 155_393 (D=32, `uep-zk count-constraints`) |
| Public inputs | 13 (domain_id is input 13) |
| circuit_hash (= circuit_metadata_id) | `0x4a06417077a45cec18709c3c5e5ad6760401235cd0f89798d235a29ab07b40f1` |

## API

`setup` / `prove` / `verify` / `serialize_*` / `verify_independent`

D=4 measures 48_097. v3 added the protocol fee floor: fee = max(1, floor(amount / 1000)) and amount > 0, the same rule as the public core (`src/core/fee.ts`). v4 (v0.5.0) keys every state slot by (account, asset): the circuit computes `state_key = H_ACCOUNT(account, asset)` for the sender, recipient and treasury, constrains each Merkle index to the low `depth` bits of its key, and requires the three indices to be pairwise distinct, so two parties can never share a leaf. The fee is computed with 128-bit intermediate arithmetic (large amounts). Earlier counts (153_956 for v3, 153_098 for v2-domain, 152_621 for the 12-input circuit) are no longer current.

### Development verifying keys (pinned)

The lab uses development keys from a fixed seeded setup (`DEV_SETUP_SEED`, no ceremony). Their SHA-256 per depth and domain is pinned in [`../vectors/UEP-ZK-DEV-VK-PINS.json`](../vectors/UEP-ZK-DEV-VK-PINS.json) (`uep-zk dev-vk <depth>` prints the key). TypeScript verifiers load the key from the pin file and only accept proofs under the pinned key; a key carried in a message must match it. A deployment supplies its own pin file through `UEP_ZK_VK_PINS_FILE`. Field inputs are parsed canonically (values >= p are rejected, no truncation).
