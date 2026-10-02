# UEP-NET-001 — network profile

This is the lab profile. It is not a testnet.

| Field | Value |
|---|---|
| profile | UEP-NET-001 |
| kind | LAB |
| networkId | uep-lab-1 |
| domainId | lab-earth-0 |
| depth | 32 |
| hash | BN254 Poseidon t=3 alpha=5 |
| circuit | UEP-27-SPEND-POSEIDON-D32-v2-domain |
| keys | DEV-TEST-KEYS |
| ceremony | no |
| fee | 10 bps, experimental |

A profile marked TESTNET cannot activate while the keys are DEV-TEST-KEYS and there is no ceremony.
domainId is public input 13 of the SpendCircuit and is folded into the transaction commitment. Encoding version is 2. D=32 measures 153_098 constraints. D=4 measures 45_802.
