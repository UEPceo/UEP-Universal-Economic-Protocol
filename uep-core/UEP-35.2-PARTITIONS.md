# UEP-35.2 — Partition suite

| Scenario | Expected |
|---|---|
| Minority 2/4 finalize | REJECT (quorum 3) |
| Split A\|B conflicting roots | neither FINAL |
| Heal + full quorum | single FINAL, all nodes |
| enterPartition | messages dropped |
