# UEP Public Release Boundary

This document defines what may be published in the public repository and what remains outside it.

## Included

- Minimal UEP economic primitives required by the public local TESTNET.
- Public TESTNET network profile.
- Local in-process ledger implementation.
- Test identity derivation required for reproducible transactions.
- Public transaction, note, nullifier, SMT and fee primitives used by the reference path.
- Public Marketplace implementation.
- Marketplace tests and synthetic simulation.
- Reproducibility scripts and examples.
- Public-facing architecture and threat-model documentation.

## Excluded

- Private keys and credentials.
- `.env` files and secret deployment configuration.
- Production proving keys, ceremony secrets and confidential cryptographic material.
- Internal infrastructure endpoints or credentials.
- Private audit reports and internal security communications.
- Internal agent prompts, Grok workflows and operational instructions.
- Internal PWA/authentication/application infrastructure unrelated to the public testnet.
- Internal consensus experiments that are not required to reproduce the public local testnet.
- Internal screenshots, temporary artifacts and development-only outputs.
- Personal data and confidential third-party information.

## Publication rule

A file is not public merely because it exists in the internal master repository. Before adding new material, classify it as:

1. **Public implementation** — may be included.
2. **Public documentation** — may be included after review.
3. **Internal research** — exclude unless deliberately rewritten for public release.
4. **Secret / credential / private infrastructure** — never include.
5. **Unclear** — exclude until reviewed.

When in doubt, keep the material out of the public repository.
