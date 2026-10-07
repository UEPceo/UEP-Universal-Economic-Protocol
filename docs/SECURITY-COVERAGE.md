# Security Review Coverage Matrix

This document states the review status of the public UEP reference. It is a disclosure record, not a certification or legal opinion. The project never describes any state as "audited", "secure" or ready for production use.

**Last externally assessed threshold with a published remediation document: v0.4.6.**

| Version | Independent assessment | Public remediation document | Notes |
|---|---|---|---|
| v0.3.2 – v0.4.6 | Yes | `PUBLIC-SECURITY-REMEDIATION-v0.4.1.md` … `v0.4.6.md` | Per-finding status published |
| v0.4.7 | Yes, non-public report | None | Fixes landed (CHANGELOG 0.4.7); no remediation report published |
| v0.5.0 | Yes, non-public reports | None | Fixes landed in 0.5.0/0.5.1 (CHANGELOG); no remediation report published |
| v0.5.1 | No | None | Deterministic transitions, compatibility policy |
| v0.5.2 | Yes, non-public report on main `7173d37` (0 P0, 0 P1) | None | Findings addressed on the `v0.5.3-fixes` branch |
| v0.5.3 (branch) | No | None | Local tests only, see `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` |

## How to read this

- "Independent assessment" means a reviewer outside the code author reviewed that commit. A non-public report is **not** a validation of the release: the fixed state was not re-assessed and the per-finding status is not published.
- CHANGELOG entries that mention fixes from an assessment of v0.4.7 or v0.5.0 refer to these non-public reports. They do not move the threshold above v0.4.6.
- `docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md` lists every security-relevant feature added since v0.4.6, the tests that cover it and its status. It is a self-assessment.
- Do not interpret main or any branch as externally validated or ready for production.
- A future release can move the threshold only with a published remediation document matching an independent assessment of that exact commit.
