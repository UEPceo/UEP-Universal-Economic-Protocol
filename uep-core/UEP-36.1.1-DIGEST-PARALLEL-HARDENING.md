# UEP-36.1.1 — Digest / Parallel Hardening

## Corrected semantics

| Term | Meaning in UEP |
|---|---|
| **parallel-safe scheduling** | Conflict-free waves applied **sequentially** (deterministic) |
| **true concurrent execution** | NOT implemented (no Promise.all / threads) |
| **DigestAggregate** | Availability + identity of batches |
| **stateRoot** | Result of **execution** after consensus, not part of aggregate commitment |

## DigestAggregate (36.1.1)

```
epoch, height, previousStateRoot
entries[{ batchId, txDigest }]  // unique batchId required
aggregateDigest = SHA-256(canonical length-prefixed bytes)
```

- No `stateRootHint` in commitment
- Canonical encoding resists `|` delimiter ambiguity
- Context binding: epoch / height / previousStateRoot

## DEMONSTRATED

- digest-only aggregate + tamper resistance  
- deterministic aggregate encoding  
- conflict-free wave **scheduling** (not concurrent exec)  
- full `stateRoot` equivalence under same schedule  
- deterministic multi-leader availability (seeded IDs)  
- process multi-leader heights 1→2→3, same root  

## NOT YET

- true concurrent execution  
- aggregate wired into CommitCert / Finality  
- production BFT  
- Poseidon/SMT execution roots  
- global-scale throughput  

## Path to v36.2

```
DigestAggregate → Proposal → Vote → CommitCert → Finality
→ parallel-safe execution of certified bodies
```

Aggregate is **input** to consensus, not a finality proof.


## Superseded semantics
See **UEP-36.1.2-EXECUTION-SEMANTICS.md** for sequential≡scheduled and official payload.
