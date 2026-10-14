# UEP BFT lock and round-change slice — 0.5.75

## Status

Experimental safety-kernel improvement only. This is not a production BFT implementation and is not connected to `PeerNet` or the ledger.

## Safety rules represented in the kernel

- A validator set must satisfy `n >= 3f + 1`; the quorum is `2f + 1` distinct validator identities.
- A validator votes only after verifying the designated leader's proposal signature.
- A precommit vote requires a valid same-height, same-round, same-block prevote certificate.
- A `2f+1` prevote certificate establishes a height lock. The lock cannot be replaced by a conflicting block unless a proposal carries a valid higher-round prevote certificate.
- Any proposal for round greater than zero must carry a valid round-change quorum certificate.
- The new-round proposal must respect the highest certified lock reported by that round-change quorum.
- Round-change messages are signed and bind network, domain, height, target round, validator, lock round/block and lock certificate.
- The exported state format is version 2 and includes locks; import verifies lock certificates before accepting state.
- `recordCommit` accepts only a verified precommit certificate, never a prevote certificate.

## Commands and observed results

- `npm run check:version` — passed for 0.5.75.
- `npm run test:consensus-bft` — 13/13 passed on Node.js 22.16.0.
- `npm run test:consensus` — 57/57 passed on Node.js 22.16.0.
- `npm test` — started but did not finish within the available execution window; no overall pass is claimed.
- A targeted `tsc` invocation could not complete because this repository does not install Node.js type declarations (`@types/node`); it reported missing `Buffer` and `node:*` type declarations. This is an environment/type-dependency limitation, not evidence that type-checking passed.

## Still required

1. Independent protocol review against a named, complete BFT specification.
2. Authenticated, bounded transport and timeout-driven round orchestration.
3. Durable atomic persistence of votes and locks before signing/responding; the current export/import API is not fsync-backed persistence.
4. Ledger integration that applies state only after a verified commit certificate.
5. Certified checkpoint/snapshot recovery, validator-set epoch management and anti-replay rules.
6. Adversarial multi-process/network tests, fuzzing, and independent audit.

Do not use this experimental kernel for real value or advertise the network as BFT-secure yet.
