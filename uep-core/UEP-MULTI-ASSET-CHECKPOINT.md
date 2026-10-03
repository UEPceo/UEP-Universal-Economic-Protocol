# Multi-asset design checkpoint (lab, no implementation)

> Historical lab note. It describes the consensus/SMT labs, where leaves use a
> fixed `CANONICAL_ASSET_ID`. The public testnet ledger keeps balances per
> account and asset and commits the asset id into notes; v0.4.7 added per-asset
> hardening (see `CHANGELOG.md` and `ROADMAP.md`, "Multi-asset").

Current lab state: a fixed `CANONICAL_ASSET_ID` in the leaves.

Before the leaves are frozen for good, the asset id has to be part of:
account identity, leaf encoding, SMT index, state root, fee, per-asset treasury,
escrow, settlement and the ZK public inputs.

No second parallel ledger. Not to be implemented in milestone A.1.
