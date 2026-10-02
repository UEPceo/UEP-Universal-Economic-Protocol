# D=32 account index scalability (study note)

`index = lowBits(owner, 32)` → 2^32 bins.

| Accounts | Birthday collision risk (approx) |
|----------|----------------------------------|
| 10^4 | negligible |
| 10^5 | low |
| 10^6 | moderate |
| 10^7 | material |

No cambiar D en A.1. Opciones futuras: D mayor, sharding por domain, buckets. Global scale no cerrado.
