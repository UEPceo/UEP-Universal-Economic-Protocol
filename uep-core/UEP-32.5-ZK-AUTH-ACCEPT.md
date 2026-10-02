# UEP-32.5 — ZK-Authenticated State Acceptance

## Signed envelope body (fixed)

Canonical `envelopeBody` now includes when present:

- `vkHex`
- `proofHex`
- `publicInputsHex` (all 12)

Tampering any of these invalidates Ed25519 verification.

## Replica APPLY order

1. Ed25519 signature  
2. network / domain  
3. sequence / previous root / replay  
4. **Groth16 verify** (if `requireZkVerify`)  
5. public root binding (pi0/pi1 vs prev/next when 64-hex)  
6. APPLY  

## Profiles

| Profile | requireProof=false | ZK verify on accept |
|---|---|---|
| DEV-STRUCTURAL | allowed | no |
| DEV-ZK | allowed | yes |
| **TESTNET-ZK** | **forbidden** | **yes** |

## E2E

Payment → Engine Groth16 D=4 → signed envelope (proof+pubs) → Auth TCP → Replica **zkVerify** → same root
