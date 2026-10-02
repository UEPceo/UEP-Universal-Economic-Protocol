# UEP-34.6 — CommitCert enforced inside LabNode.apply

## Fix

When `requireCommitCert = true`:

```
apply(env)                    → COMMIT_CERT_REQUIRED
apply(env, { commitCert })    → verify digest + quorum + board
```

Digest = `UEP-34.5-PROP|` + full `envelopeBody(env)` (includes proof/vk/pubs/ts/…).

## API

```ts
new LabNode(..., {
  requireCommitCert: true,
  commitCandidates: [...],
  commitPublicKeyOf: (id) => ...,
  proposalBoard,
})
```

Structural lab (requireCommitCert false) unchanged for non-BFT paths.
