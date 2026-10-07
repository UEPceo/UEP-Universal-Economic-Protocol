# Contributing to UEP Public Testnet + Marketplace

Thank you for testing UEP.

## Before contributing

Please read:

- `README.md`
- `ROADMAP.md`
- `docs/ARCHITECTURE.md`
- `PUBLIC-SCOPE.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `LICENSE`

## Where to start

- **Where help is needed:** [`ROADMAP.md`](./ROADMAP.md) lists the current phases and milestones. The most useful areas right now are Phase 2 (event bus, storage and evidence, local API, SDK, simulators), additional negative and property-based tests, and reproducibility reports. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) shows which layers are implemented, partial or still design.
- **Questions and ideas:** use [GitHub Discussions](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/discussions) (Q&A, Ideas, Show and tell).
- **First contributions:** look for issues labelled [`good first issue`](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/labels/good%20first%20issue) or [`help wanted`](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/labels/help%20wanted). Area labels (`area:ledger`, `area:marketplace`, `area:iot`, `area:docs`) show which part of the code an issue touches.
- **Bugs and feature requests:** open an issue with the [bug report](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=bug_report.yml) or [feature request](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=feature_request.yml) form.
- **Security vulnerabilities:** never in a public issue, discussion or pull request. Follow [`SECURITY.md`](./SECURITY.md) and report privately via [GitHub private vulnerability reporting](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/security/advisories/new) or to uep.dev@proton.me.

## Local setup

Requires Node.js >= 22.6 (no runtime dependencies). The research labs in `npm run test:all` also need Rust 1.85 (`cargo`):

```bash
npm ci
npm run test:all       # everything below, in order
npm test               # protocol + Marketplace + IoT/M2M suites
npm run smoke:testnet  # deterministic testnet smoke test
npm run quickstart     # first-transaction example with uep1 addresses
npm run simulate:20k   # in-process 20k settlement simulation
npm run test:rust      # research Rust crates (uep-core/)
npm run build:uep-zk   # build the research uep-zk prover from source
npm run test:lab       # research labs (src/lab, src/agent, service/API lab), see docs/LABS.md
```

Lab code is experimental. Changes to protocol rules belong in `src/core` and `src/testnet` first; labs import those modules rather than copying them. To run a subset of the labs, pass a path fragment: `npm run test:lab -- uep36` runs only the lab files whose path contains `uep36`. Older lab design notes in `uep-core/` sometimes mention `npm run test:<milestone>` scripts from the internal workspace; in this repository use `npm run test:lab -- <fragment>` instead (see [`uep-core/README.md`](./uep-core/README.md)).

CI runs `npm run test:core` (lint, snapshot compatibility, donation-address check, all core suites, smoke, quickstart, 20k simulation, Rust) on Node.js 22.x and 24.x, and `npm run build:uep-zk && npm run test:lab` in a separate `labs` job; both are blocking. The lab files listed in `scripts/lab-known-issues.json` run in a separate non-blocking job (`npm run test:lab:known`). If you fix a known-issue lab, remove it from that file in the same pull request so that CI starts blocking on it.

## Finding your way around

- [`docs/MODULES.md`](./docs/MODULES.md): every module with its status (implemented (testnet), experimental (lab), planned), the version it appeared in, its test command and its documentation.
- Each module directory has a short `README.md` (`src/core`, `src/testnet`, `src/marketplace`, `src/settlement`, `src/category`, `src/oracle`, `src/service`, `src/lab`, `src/agent`).
- [`docs/adr/`](./docs/adr/): architecture decisions (asset model, determinism, compatibility, multi-input transactions).
- [`docs/SECURITY-COVERAGE.md`](./docs/SECURITY-COVERAGE.md) and [`docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md`](./docs/REMEDIATION-COVERAGE-v0.4.7-v0.5.x.md): what was externally assessed (up to v0.4.6) and what was only reviewed internally since then. Independent reviews of the v0.4.7 – v0.5.x changes are among the most useful contributions.

## Project rules a change must keep

These are part of the project's design, not style preferences. A pull request that changes one of them will not be merged without a design discussion first:

- no native token and no common currency; assets are namespaced and issued by their own issuers;
- protocol fee 0.1 % (`max(1, floor(amount / 1000))`), Marketplace fee 3 %;
- no runtime dependencies (Node.js built-ins only for the TypeScript code);
- time in protocol transitions is block height, never wall-clock time (`npm run lint:determinism`, ADR 0002);
- any change to a snapshot format, transaction id or receipt hash comes with a migration or a versioned alias, golden fixtures and tests (ADR 0003, `npm run check:snapshot-compat`);
- the oracle is policy-only: it never holds balances and is never on the spend or consensus path;
- documentation never calls the code "audited", "secure" or production-ready.

## Good first contributions

Templates: [good first issue](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=good_first_issue.yml), [bug report](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=bug_report.yml), [feature request](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=feature_request.yml). Self-contained tasks that need no deep protocol knowledge, for example:

- **Lab stability:** pick a file from `scripts/lab-known-issues.json`, find why it is timing-dependent (most are multi-process timeouts) and make it deterministic; then remove it from the list.
- **Test vectors:** add published vectors for a primitive that has none yet (for example more RFC 8439 ChaCha20-Poly1305 AEAD vectors) to `src/core/crypto-vectors.test.ts`.
- **Negative tests:** add a rejected-input test to a category module (`src/category/category-hardening.test.ts` uses the shared harness in `category-testkit.ts`).
- **Docs:** check that a per-module `README.md` matches the code it describes; fix stale counts or names.
- **Reproducibility:** run `npm run test:all` on a platform not listed in `docs/REPRODUCIBILITY.md` and report the result.

## Reviewing and maintaining

The project currently has one maintainer. To reduce that risk, reviews from contributors are welcome on any pull request: a review that says which property was checked, and how, is useful even without merge rights. Contributors with a record of careful reviews in one area can be proposed as code owners for that area in `.github/CODEOWNERS`.

## Good public contributions

Examples include:

- reproducibility fixes;
- deterministic test vectors;
- additional negative/security tests;
- documentation corrections;
- performance measurements with complete methodology;
- Marketplace lifecycle tests;
- independent compatibility implementations;
- reviews of the research labs (circuit constraints, consensus experiments) that state clearly which property was checked;
- clear bug reports with minimal reproduction cases.

## Do not submit

Never commit:

- private keys;
- passwords or tokens;
- `.env` files containing credentials;
- customer/user personal data;
- production endpoints or credentials;
- confidential assessment material;
- undisclosed private vulnerability details;
- proprietary material belonging to third parties.

## Claims and benchmarks

Do not describe a local benchmark as a public-network capacity guarantee. Include hardware, Node.js version, command and test configuration with performance claims.

Likewise, do not describe development/reference cryptography as production ZK security.

## Pull requests

Pull requests use the [pull request template](./.github/pull_request_template.md). A good pull request should explain:

1. what changed;
2. why it changed;
3. what tests were added or run;
4. whether the change affects protocol serialization or transaction identifiers;
5. whether any security assumption changed.

Protocol-affecting changes should include deterministic tests where practical. User-visible changes should add a `CHANGELOG.md` entry.

Repository documentation is written in English. When a document describes a capability, label it as implemented (testnet), experimental (lab), planned or research, as the README does.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Report unacceptable behaviour to uep.dev@proton.me.
