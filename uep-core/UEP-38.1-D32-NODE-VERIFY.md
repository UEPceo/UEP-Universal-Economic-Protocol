# UEP-38.1 / 38.2

DEMONSTRATED
- D=32 prove-spend-json roots == SMT stateRoot before/after (same accounts as D=4)
- Golden: uep-core/vectors/UEP-38.1-D32-GOLDEN.json
- Replica verify-hex (vk + proof + 12 publics) BEFORE apply
- Tampered proof rejected; replica root unchanged
- public_0 must equal current SMT root

test:38.1 → 5/5 PASS (~41s)

NOT YET
- Multi-node envelope carrying this artifact
- Holds in circuit
- Production ceremony
