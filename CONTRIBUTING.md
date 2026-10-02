# Contributing to UEP Public Testnet + Marketplace

Thank you for testing UEP.

## Before contributing

Please read:

- `README.md`
- `PUBLIC-SCOPE.md`
- `SECURITY.md`
- `LICENSE`

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

A good pull request should explain:

1. what changed;
2. why it changed;
3. what tests were added or run;
4. whether the change affects protocol serialization or transaction identifiers;
5. whether any security assumption changed.

Protocol-affecting changes should include deterministic tests where practical.
