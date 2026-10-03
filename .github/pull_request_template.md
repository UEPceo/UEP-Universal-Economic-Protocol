## Summary

<!-- What changed and why? Link the issue it addresses, e.g. "Closes #123". -->

## Tests

<!-- Which tests did you add or run? -->

## Checklist

- [ ] `npm test` passes on Node.js 22 and 24 (CI runs both)
- [ ] `npm run smoke:testnet` passes
- [ ] `npm run test:all` passes if the change touches the research labs or `uep-core/` (needs Rust 1.85)
- [ ] New or changed behaviour has tests (including negative tests where relevant)
- [ ] `CHANGELOG.md` is updated (if the change is user-visible)
- [ ] Docs are updated (`README.md`, `docs/API.md`, examples) where relevant
- [ ] No secrets: no private keys, mnemonics, tokens, passwords, `.env` files or personal data
- [ ] No undisclosed vulnerability or exploit details (see `SECURITY.md`)

## Protocol impact

- [ ] This change does **not** affect protocol serialization, transaction identifiers, addresses or the snapshot format
- [ ] This change **does** affect them, and the impact is described above

Security assumptions changed? <!-- no / yes: explain -->
