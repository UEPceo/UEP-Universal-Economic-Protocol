# Contributing to UEP Public Testnet + Marketplace

Thank you for testing UEP.

## Before contributing

Please read:

- `README.md`
- `PUBLIC-SCOPE.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- `LICENSE`

## Where to start

- **Questions and ideas:** use [GitHub Discussions](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/discussions) (Q&A, Ideas, Show and tell).
- **First contributions:** look for issues labelled [`good first issue`](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/labels/good%20first%20issue) or [`help wanted`](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/labels/help%20wanted). Area labels (`area:ledger`, `area:marketplace`, `area:iot`, `area:docs`) show which part of the code an issue touches.
- **Bugs and feature requests:** open an issue with the [bug report](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=bug_report.yml) or [feature request](https://github.com/UEPceo/UEP-Universal-Economic-Protocol/issues/new?template=feature_request.yml) form.
- **Security vulnerabilities:** never in a public issue, discussion or pull request. Follow [`SECURITY.md`](./SECURITY.md) and report privately to uep.dev@proton.me.

## Local setup

Requires Node.js >= 22.6 (no runtime dependencies):

```bash
npm ci
npm test               # protocol + Marketplace + IoT/M2M suites
npm run smoke:testnet  # deterministic testnet smoke test
npm run quickstart     # first-transaction example with uep1 addresses
```

CI runs `npm test` and the smoke test on Node.js 22.x and 24.x.

## Good public contributions

Examples include:

- reproducibility fixes;
- deterministic test vectors;
- additional negative/security tests;
- documentation corrections;
- performance measurements with complete methodology;
- Marketplace lifecycle tests;
- independent compatibility implementations;
- clear bug reports with minimal reproduction cases.

## Do not submit

Never commit:

- private keys;
- passwords or tokens;
- `.env` files containing credentials;
- customer/user personal data;
- production endpoints or credentials;
- confidential audit material;
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

## Code of Conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Report unacceptable behaviour to uep.dev@proton.me.
