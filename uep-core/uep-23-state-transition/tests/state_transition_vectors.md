# UEP-23 state-transition attack matrix

For `amount = 100_000`:

- fee = 100
- remainder = 0
- old_balance = 200_000
- new_balance = 99_900

Expected:

| Mutation | Expected |
|---|---|
| fee 100 | accept |
| fee 99 | reject |
| fee 101 | reject |
| remainder 0 | accept |
| remainder 1 with amount 100001 | accept |
| remainder 1000 | reject |
| old_balance too small | reject |
| old_root changed | reject |
| new_root changed | reject |
| sibling changed | reject |
| direction bit changed | reject |
| nullifier changed | reject |
| treasury commitment changed | reject |
| duplicate nullifier already in Nullifier SMT | reject at state layer |

The last row is deliberately a network-state rule: a single transaction proof
can prove correct nullifier derivation, but global uniqueness requires a
membership/non-membership check against the accumulated nullifier state.
