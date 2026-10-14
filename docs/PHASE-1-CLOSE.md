# Phase 1 engineering close — 0.5.11

Phase 1 goal: anyone can run the reference testnet and check the economic rules without the team.

## Closed here

- `requireProof` stays fixed at construction (v0.4.7).
- Development MAC retirement plan: `docs/DEV-MAC-RETIREMENT.md`. Step 1 is in this release: a node ledger rejects `development-mac`. Tests that still exercise the MAC pass `testOnlyAllowDevelopmentMac`.
- Architecture and roadmap: `docs/ARCHITECTURE.md`, `ROADMAP.md`.
- Reproduction: `docs/REPRODUCIBILITY.md`. Commands below are the ones a third party runs from a clean clone.
- Canonical state for the next phase: ADR 0005 (UEP-25). The reference node is `npm start`.

## Not claimed

An independent assessment with no new critical or high finding is an external exit criterion. This tree does not invent that assessment. Phase 4 does not start on a spend whose check needs the sender secret; step 2 of the MAC plan (delete the provider from the node path) is still open and is not required to leave Phase 1 engineering.

## What a third party runs

Node.js 22.6 or newer, and 24 for the second CI line. Rust 1.85 only for `npm run test:rust` and `npm run test:all`.

```text
npm install
npm test
npm run test:poisoned-clock
npm run smoke:testnet
npm run quickstart
npm run simulate:20k
npm run check:version
```

`npm run test:all` adds the Rust build and the labs. A failure in a file listed in `scripts/lab-known-issues.json` is expected only when that list is non-empty.
