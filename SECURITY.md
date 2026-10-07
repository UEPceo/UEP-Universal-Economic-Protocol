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
- the Poseidon protocol hash implementation and its test vectors;
- addresses, key-derived account ids and sender signatures;
- snapshot signing, restore and issuance (faucet and issuer keys);
- per-asset isolation of balances, issuance, limits and fees;
- IoT/M2M telemetry verification and settlement;
- policy/authentication bypass;
- Marketplace action authorization, including the signed actor headers of the HTTP/service API;
- accidental secret exposure.

Reports about the **research labs** (`src/lab`, `src/agent`, the service/API lab in `src/service`, `uep-core/`, including the UEP-26 circuit and `uep-zk`) are also welcome. The labs are experimental and make no security claim, so a lab issue is treated as research input unless it also affects the testnet reference path. Please use the same private channel for anything that could matter for a future production design (for example a soundness problem in the circuit).

## Supported versions

Reports should target the current `main` branch or the latest GitHub Release. Older releases are superseded testnet snapshots and do not receive separate fixes.

## Important limitation

Passing the public tests does not establish production security. The public testnet is local/in-process and the cryptographic spend path is a development/reference mechanism.

## Zero-knowledge labs: development keys only

The Groth16 verifying keys pinned in `uep-core/vectors/UEP-ZK-DEV-VK-PINS.json` are **development keys only**. No multi-party setup ceremony has been held, so ZK proof verification in the labs is **not trustworthy** and must not be used to accept value. Pinning (v0.5.0) guarantees that verifiers never take a key from the message that carries a proof; it does not make the pinned keys safe. The earlier review item about verifiers trusting a carried key is therefore addressed with pinned keys for development only, not as a soundness fix. The testnet ledger accepts a `zk-spend` only with an explicitly configured verifier (v0.5.3), still requires the sender signature, and refuses development-key verifiers under `NODE_ENV=production`. Since v0.5.1 the development pin file is refused when `NODE_ENV=production` or `UEP_ZK_KEY_MODE=production` is set, and a pin file not labelled `DEV-TEST-KEYS` may not list a development key. Promoting ZK verification beyond the labs requires a real ceremony and a separate pin file.

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
