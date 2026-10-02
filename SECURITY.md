# Security Policy

## Scope

This repository is an experimental public reference implementation. Security reports are welcome for:

- transaction integrity;
- replay/double-spend handling;
- ownership binding;
- commitment/nullifier correctness;
- state-transition invariants;
- Marketplace authorization and settlement;
- Treasury accounting;
- Paymaster accounting;
- deterministic serialization;
- transaction domain separation;
- policy/authentication bypass;
- Marketplace action authorization;
- accidental secret exposure.

## Important limitation

Passing the public tests does not establish production security. The public testnet is local/in-process and the cryptographic spend path is a development/reference mechanism.

## Responsible disclosure

For vulnerabilities that could materially affect users or future deployments, please avoid immediately publishing exploit details.

**Do not report vulnerabilities in public issues, discussions or pull requests.** Report them privately through GitHub's [private vulnerability reporting](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/security/advisories/new) (Security tab → "Report a vulnerability") or by email to **uep.dev@proton.me**. If you only need a private channel first, email a short note without exploit details and we will reply.

## Never publish

Do not include in public issues or pull requests:

- private keys;
- authentication tokens;
- passwords;
- personal data;
- production credentials;
- private infrastructure addresses;
- unpublished ceremony material.

## Security reports should include

- affected version/commit;
- precise reproduction steps;
- expected vs actual behavior;
- security impact;
- whether the issue requires special privileges;
- any relevant deterministic test case.

Security contact: uep.dev@proton.me
