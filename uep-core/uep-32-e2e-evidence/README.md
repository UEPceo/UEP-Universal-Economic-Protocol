# UEP-32 E2E evidence

## Suite: `npm run test:e2e` / e2e-pipeline.test.ts

| Path | Result | Notes |
|---|---|---|
| Structural (requireProof=false) | PASS | ~100ms |
| ZK D=4 Groth16 (requireProof=true) | PASS | ~5.5s wall |

Pipeline:

```
PaymentRequest (HMAC)
  → SpendIntent
  → ExecutionEngine prove+commit
  → NodeEnvelope (Ed25519)
  → Auth TCP handshake
  → Replica state root == Sequencer
```

Binary: uep-zk with h-account / note-commit / prove-spend-json
