# UEP units

`amount`, `price`, `fee`, `locked` and `treasury` are **integer units of an unspecified asset**.

They are **not** Ethereum wei.

- No 18-decimal convention.
- No `1e18`.
- No native token.
- Fixture comments that say "wei" are informal test labels only.

A future multi-asset model (P4, not now) would attach `assetId` + precision per resource.
