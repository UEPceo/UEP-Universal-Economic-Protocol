# UEP-38.0 — Phase 4 bridge (lab)

DEMONSTRATED
- SmtEconomicState leafMode=poseidon-zk, D=4
- Account IDs bound to circuit H_ACCOUNT / recipient Fr
- prove-spend-json Groth16 DEV keys
- public old_state_root / new_state_root === SMT stateRoot before/after transfer
- test:38 4/4 PASS (~7s)
- test:37.4 12/12 PASS

NOT YET
- D=32 E2E on this path (circuit works; ~7s prove; not in this suite)
- Holds / obligations inside SpendCircuit
- economicTip as Groth16 public input
- Production keys / ceremony
- Multi-node verify of this proof
- Wallet production

NEXT
38.1 D=32 same vector
38.2 node verifies proof against stateRoot before apply
38.3 holds commitment still off-circuit (document until circuit change is justified)
