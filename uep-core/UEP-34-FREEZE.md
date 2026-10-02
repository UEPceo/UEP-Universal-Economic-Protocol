> Histórico. Describe el circuito de 12 entradas y 152_621 restricciones. El circuito actual, con domain_id, mide 153_098 en D=32 y 45_802 en D=4. Ver UEP-38.34-CONSTRAINTS.md.

# UEP-34 — FREEZE

**Status:** FROZEN as of 2026-09-28  
**Last revision:** v34.6 (apply + CommitCert binding)

## What 34.x is

Lab consensus / failover layer for UEP:

| Component | Version |
|---|---|
| Deterministic election + modes | 34.0 |
| Heartbeat anti-replay | 34.1 / 34.3 |
| Quorum cert + vote log | 34.2 / 34.3 |
| Real Voter lock + evidence + BFT n/f | 34.4 |
| ProposalBoard + VoteBoard + CommitCert | 34.5 |
| LabNode.apply requires CommitCert; full envelope digest | 34.6 |

## Regression evidence (freeze gate)

```
npm run test:34  →  39/39 PASS, 0 FAIL, 0 SKIP
```

ZK artifact (included binary, executed from exec-capable path):

```
tag=UEP-27-SPEND-POSEIDON-D32-v1
constraints=152621
public_inputs=12
demo-d4: ok=true  prove≈2.1s  verify≈4ms
SHA-256: 1feac8986e203c9b28d2d5895344faf1d405ea285b6bf6201ef502ac32283a8e
```

## Explicit non-claims (do not reopen as 34.x patches)

- Not multi-host gossip
- Not partition-complete BFT finality under arbitrary networks
- Not TX-batch prepare/precommit/commit pipeline
- Not production ceremony
- Not millions TPS

## Policy

Do **not** add further 34.x feature patches.  
Bugs that break freeze gates may get a **34.6.x hotfix** only.  
All new architecture → **UEP-35**.

## Classic BFT note for 35

Prefer explicit `N = 3f+1`, `quorum = 2f+1`, reject non-classic `N` on BFT paths  
(rather than generic `majorityThreshold` alone).
