# Security Review Coverage Matrix

This document states the review status of the public UEP reference. It is a disclosure record, not a certification or legal opinion. The project never describes any state as "audited", "secure" or ready for production use.

**External reviews of later versions have taken place; their reports are not yet published in this repository and will be added (with version and remediation status) as they are incorporated. The last externally reviewed threshold with a published report in this repository is v0.4.6.**

| Version | Independent assessment | Public remediation document | Notes |
|---|---|---|---|
| v0.3.2 – v0.4.6 | Yes | `PUBLIC-SECURITY-REMEDIATION-v0.4.1.md` … `v0.4.6.md` | Per-finding status published |
| v0.4.7 | Yes; report not yet published in this repository | None | Fixes landed (CHANGELOG 0.4.7); no remediation report published |
| v0.5.0 | Yes; reports not yet published in this repository | None | Fixes landed in 0.5.0/0.5.1 (CHANGELOG); no remediation report published |
| v0.5.1 | Report not yet published in this repository | None | Deterministic transitions, compatibility policy |
| v0.5.2 | Yes, on main `7173d37`; report not yet published in this repository | None | Findings addressed in v0.5.3 |
| v0.5.3 | Report not yet published in this repository | None | See `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` |
| v0.5.3 (pre-release commit `2cc37f3`) | External review provided by the project director, 2026-10-08; report not published in this repository | Per-finding verification and status in `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` (section "External review provided by the project director, 2026-10-08") | 8 findings. Confirmed and fixed: 1 (Marketplace state persistence), 5 (relay payload encryption), 6 (event-loop blocking, mitigated by a worker thread), 7 (history scans), 8 (unbounded maps). Partly confirmed and fixed: 2 (submit queue / backpressure). Confirmed as residuals: 3 (ZK, documented) and 4 (height operator, mitigated by the height authority). Regression test per fix, released in v0.5.3 |

## How to read this

- "Independent assessment" means a reviewer outside the code author reviewed that commit. Until its report is published in this repository, the per-finding status of a review is not public here; reports are added with version and remediation status as they are incorporated.
- CHANGELOG entries that mention fixes from an assessment of v0.4.7 or v0.5.0 refer to these reviews; their reports are not yet published in this repository. The threshold above (v0.4.6) moves when a later report is published in this repository.
- `docs/EXTERNAL-AUDIT-PACKAGE.md` is the starting point for an independent review of v0.5.3 (scope, threat model, reproduction, accepted residuals). It is not a review result.
- `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` lists every security-relevant feature added since v0.4.6, the tests that cover it and its status. It is a self-assessment.
- Do not interpret main or any branch as externally validated or ready for production.
- A future release can move the threshold only with a published remediation document matching an independent assessment of that exact commit.
