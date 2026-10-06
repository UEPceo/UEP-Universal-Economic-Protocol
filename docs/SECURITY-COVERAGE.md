# Security Review Coverage Matrix

This document states the current review status of the public UEP reference. It is a disclosure record, not a certification or legal opinion.

| Version | Status | External review | Remediation document | Notes |
|---|---|---|---|---|
| v0.3.2 | Reviewed | Yes | `PUBLIC-SECURITY-REMEDIATION-v0.4.1.md` and related public remediation files | Public security fix release |
| v0.4.1–v0.4.6 | Reviewed | Yes | `PUBLIC-SECURITY-REMEDIATION-v0.4.1.md` through `PUBLIC-SECURITY-REMEDIATION-v0.4.6.md` | Reviewed externally and documented |
| v0.4.7 | Not externally reviewed | No | None | Multi-asset and per-asset hardening in the project history |
| v0.5.0 | Not externally reviewed | No | None | API auth, signed spends, paymaster caps, circuit v4, asset registry work |
| v0.5.1 | Not externally reviewed | No | None | Deterministic transitions and compatibility policy work |
| v0.5.2 | Not externally reviewed | No | None | Current main branch state |

## Important interpretation

The repository should be read as follows:

- Reviewed versions are those with a public remediation document and a documented public review in the project history.
- Unreviewed versions are still useful research and engineering work, but they are not an externally validated release.
- This document does not imply that a later version is insecure; it only makes clear that the project has not yet published a matching external remediation report for the newest changes.

## Review posture by change set

### v0.4.7

The v0.4.7 work includes multi-asset hardening, per-asset keys and fee-floor behavior. These changes are important, but the project history does not include a separate external review against that state.

### v0.5.0

The v0.5.0 changes include signed spends, service API authorization hardening, paymaster caps and the circuit v4 work. These are significant security-relevant changes and should be considered pending external review until a dedicated remediation document and review are published.

### v0.5.1 and v0.5.2

The project continues to evolve on main with settlement engine, category modules, oracles and deterministic timing work. These changes are experimental, documented and tested locally, but not yet covered by an external review.

## Operational guidance

- Treat v0.4.6 as the last externally reviewed public threshold for this repo.
- Treat v0.4.7–v0.5.2 as research / public reference states pending independent review.
- Do not interpret the current main branch as audited or production-ready.
- Any future public release should include a matching remediation document before claiming a fully reviewed state.
