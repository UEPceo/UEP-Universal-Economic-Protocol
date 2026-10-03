# UEP Public Release Boundary

This document defines what may be published in the public repository and what remains outside it.

## Included

- Minimal UEP economic primitives required by the public local TESTNET.
- Public TESTNET network profile.
- Local in-process ledger implementation.
- Test identity derivation required for reproducible transactions.
- Public transaction, note, nullifier, SMT and fee primitives used by the reference path.
- Public Marketplace implementation, including disputes and signed actions.
- IoT/M2M service layer (machine registry, signed telemetry, verified settlement).
- Marketplace and IoT/M2M tests and synthetic simulation.
- Reproducibility scripts and examples.
- Public-facing architecture, roadmap and threat-model documentation (`docs/ARCHITECTURE.md`, `ROADMAP.md`, `docs/THREAT-MODEL.md`).
- Per-release changelog and public security remediation notes for findings that have been fixed and disclosed.
- Research labs (`src/lab/`, `src/agent/`, the service/API lab in `src/service/`, `uep-core/`). These were internal lab experiments during the project's early stage; they are now public as experimental code, after review for publication. They are not part of the testnet reference path. See `docs/LABS.md`.

## Excluded

- Private keys and credentials.
- `.env` files and secret deployment configuration.
- Production proving keys, ceremony secrets and confidential cryptographic material.
- Internal infrastructure endpoints or credentials.
- Private assessment reports and internal security communications.
- Details of vulnerabilities that are not yet fixed and disclosed (report and track them privately, see `SECURITY.md`).
- Internal agent prompts, Grok workflows and operational instructions.
- Internal PWA/authentication/application infrastructure unrelated to the public testnet.
- Other internal material not reviewed for publication (see the exclusion policy).
- Prebuilt binaries (for example the `uep-zk` prover); build them from source.
- Exploit reproductions and test suites written for findings that are not yet fixed and disclosed.
- Internal screenshots, temporary artifacts and development-only outputs.
- Personal data and confidential third-party information.

## Roadmap and status claims

Public documents describe the state of this repository only: the local, single-node testnet. External reviews are described as independent assessments, never as a guarantee of security or production readiness. Roadmap phases and years are goals, not commitments.

## Publication rule

A file is not public merely because it exists in the internal master repository. Before adding new material, classify it as:

1. **Public implementation** — may be included.
2. **Public documentation** — may be included after review.
3. **Internal research** — exclude unless deliberately rewritten for public release.
4. **Secret / credential / private infrastructure** — never include.
5. **Unclear** — exclude until reviewed.

When in doubt, keep the material out of the public repository.
