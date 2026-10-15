# External report "Aegis-Orbit" on v0.5.81 — summary (2026-10-15)

- Report ID: `AUDIT-MV990F9F-LUPO`. Reviewed archive: v0.5.81 source, sha256 `aa48fb2b2608a60257b6d0d69a7e393bd44d06c36272fc824651475b3519b5ed`.
- Method (as stated by the report): static, pattern-based analysis. No running network was tested.
- Tally reported by the tool: 8 critical, 17 high, 8 medium.
- Finding groups: non-cryptographic randomness (`Math.random`) for identifiers, a floating-point ranking score, "hardcoded secrets" in test files, Rust `.unwrap()` in tests, "missing nullifier existence check" (pattern match), possible integer underflow in `amount + fee` / `gross - fee` arithmetic, and a roadmap note on chain/network-ID domain separation for signatures.

Exploit details are not reproduced here. The per-finding triage, the evidence and the changes are in [`0.5.82-RESOLUTION.md`](./0.5.82-RESOLUTION.md). This summary is not a statement that the software is free of defects; all evidence is single-process tests.
