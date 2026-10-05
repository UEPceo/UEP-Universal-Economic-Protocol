# Category modules (v0.5.2)

Status: **IMPLEMENTED (testnet reference)**. Swap, relay, dispute and drip over
Marketplace HOLDs. Not a production DEX, messaging network or arbitration service.

| Module | Role |
| --- | --- |
| `swap` | Bilateral cross-asset hashlock settlement (SHA-256 hashlock, not Poseidon) |
| `relay` | Chunk fraud proofs; ChaCha20 under HKDF; custody 20 % / delivery 80 % |
| `dispute` | k-of-n arbiter quorum; bonds; applies verdicts via `DisputeCap` |
| `drip` | Subsidy claims bound to the settlement index (swap/relay only) |

Funds move only through a once-issued `CategoryEscrowPort` / `SubsidyPort` from
the Marketplace. Identities and signatures are Marketplace `ActorAuth`. Heights
from the Marketplace clock. One fee path (Marketplace fee on the provider part
via the settlement engine).

Residual limits: SHA-256 category commitments (not Poseidon); in-process
capabilities; no arbiter appeal/staking; drip budget is an allowance on
DISTRIBUTABLE_PROFIT.
