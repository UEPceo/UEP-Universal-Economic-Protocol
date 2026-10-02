> Histórico. Describe el circuito de 12 entradas y 152_621 restricciones. El circuito actual, con domain_id, mide 153_098 en D=32 y 45_802 en D=4. Ver UEP-38.34-CONSTRAINTS.md.

# UEP-37.2 — Poseidon Golden Freeze (TS ↔ uep-zk)

## Status

**CLOSED for note_commitment / low-bits / h-account** against bundled `uep-zk`.

**NOT closed for SMT root** — `smt-root` + `h-merkle` are in **source** (`uep_zk.rs`) but not in the shipped binary (crates mirror 502 blocked rebuild).

## Frozen artifact

- `uep-core/vectors/UEP-37-POSEIDON-GOLDEN.json`
- `uepZkSha256`: `1feac8986e203c9b28d2d5895344faf1d405ea285b6bf6201ef502ac32283a8e`
- Circuit: `UEP-27-SPEND-POSEIDON-D32-v1`, 152621 constraints

## What tests enforce (0 SKIP)

1. Golden file present, version 37.2  
2. Binary SHA matches golden  
3. `circuit-id` runs  
4. Every `note-commit` case = live `uep-zk`  
5. `low-bits` D=32 matches  
6. `h-account` matches  
7. TS UEP-25 `noteCommitment` is **not** claimed Poseidon-identical  
8. Shipped binary still lacks `smt-root` (documents debt)

Missing binary or leaf mismatch → **FAIL**.

## Example frozen leaf

```
owner=0x2a asset=0x1 amount=0x3e8 blinding=0x0
leaf=0011b463d4a14a5faffe6f527eb73480200273eef065440bf37acb12f221daf0
```

## Next (37.3)

1. Rebuild `uep-zk` when registry works → ship `smt-root`  
2. Golden for minimal SMT roots D=8/32  
3. Align `SmtEconomicState` leaves via `uep-zk note-commit` (or Poseidon TS backend)  
4. StateWitness binding  

## Rebuild (when possible)

```bash
export CARGO_TARGET_DIR=/tmp/uep-target
cargo build --release --bin uep-zk
cp /tmp/uep-target/release/uep-zk bin/uep-zk
# regenerate golden including smt-root cases
```
