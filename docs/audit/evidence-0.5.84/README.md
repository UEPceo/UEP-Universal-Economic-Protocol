# Evidence 0.5.84, commit 1bfa198436e5502d9ca9ec4a5a3597c9aa27f305

The suites were run one at a time on one machine (8 cores) on 2026-10-16, between 06:18 and 07:33 Madrid, from a clean tree (`dirty: false`) with `scripts/run-evidence.mjs`. The records are `evidence-1bfa198436e5-node24.json` (v24.21.0) and `evidence-1bfa198436e5-node22.json` (v22.23.3). The logs are in `logs/`, and each log's SHA-256 is in its record.

On Node 22 the record shows 0/0 counts. The test runner there prints TAP (`# pass N`), which the 1bfa198 parser did not read, and the parser was fixed afterwards. The table below is recounted from the logs.

| Suite | Node 24 | Node 22 |
|---|---|---|
| test:security | 99/99 | 99/99 |
| test:core | 1201/1201 | 1201/1201 |
| test:property:full | 24 seeded runs, 0 failed | 24 seeded runs, 0 failed |
| test:bft-adversarial (4 multi-process tests) | 4/4 | 4/4 |
| test:lab (131 files, known issues excluded) | 574 passed, 0 failed | 574 passed, 0 failed |
| test:zk-d64 (`UEP_ZK_D64=1`, real proof at depth 64, uep-zk built from this commit) | 1/1 | 1/1 |

These are local results on one machine. They are not a claim about the behaviour of a distributed network.
