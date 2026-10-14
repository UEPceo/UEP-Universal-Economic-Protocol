# ADR 0006 — Consensus scope

Status: accepted for Phase 4 opening. This is not a consensus protocol.

## What is replicated

A node replicates the UEP-25 ledger: notes, nullifiers, committed transactions and the snapshot chain. Two nodes that start from the same signed snapshot and apply the same client-signed transactions must reach the same state root.

The client supplies the note opening. A node does not invent a commitment.

## What stays local

Marketplace balances, the value bridge, oracle feeds, category modules and the HTTP API are local to a node until a later decision says otherwise. An admin credit is not a replicated transition.

`src/lab/` is not the node. Known lab failures stay in `scripts/lab-known-issues.json`. Phase 4 does not promote those experiments.

## What this opening does not do

No leader election, no quorum, no view change, no partition recovery. Those are exit work, not this cut. Key rotation and revocation are required before the Phase 4 exit and are not implemented here.

## Fees and format

Protocol fee 0.1 %. Marketplace fee 3 %. Ledger snapshot format 10. No native token.

## Harness, second cut

Same client spend: same tx id and same state root. Conflicting spends of one note: the nodes diverge. A replay is `REPLAY`. The other spend, once the note is spent, is `DOUBLE_SPEND`. Divergence is expected until a quorum exists.

## Harness, third cut

A node behind restores the ahead node's signed snapshot and reaches the same root and height. No leader. The behind node is replaced by the restore; it does not merge a fork.

## Harness quorum

`src/node/quorum.ts` confirms a transaction when `threshold` distinct voters sign its id. A voter signs at most one transaction per nullifier. This is the harness rule. It is not the lab BFT, and it does not run between nodes.

## Harness, quorum applied

Three nodes apply a spend only after two votes. The conflicting spend does not reach the threshold, and the three roots match. Still one process. No network.

## Seven nodes

`n = 3f+1` with `f = 2` is 7, and the threshold is 5. Five votes confirm. Two dissenting votes do not. All seven apply the confirmed spend and share the root. Still one process.

## Key rotation

`rotateSnapshotSigners` replaces the keys that sign the next snapshot. A snapshot already signed stays valid under the keys that signed it. The old key does not sign the next one. Revocation of a historical snapshot is not this cut.

## Faucet rotation

`rotateFaucetKey` replaces the key that signs the next mint. A snapshot that holds mints from both keys restores only if trust lists both. Dropping the old key rejects the old mint. This is not revocation.

## HTTP peers

Three nodes, fixed list, no discovery. HTTP announces height and root, forwards a client spend, collects two votes and applies. A silent peer is skipped. One live node does not confirm. A behind node fetches the signed snapshot. No leader.

## Fixed list and dissent

`config/peers.json` is three written addresses and a threshold of 2. No discovery. A peer that proposes a conflicting spend of the same note does not get two votes. `publicKeyHex` in the list is the pin. Without it, the harness may learn a key once from `/status`. A learned or pinned key is never replaced.

## npm start votes

`UEP_NODE_ID` and `UEP_PEERS` start the peer port. The voter key is persisted. Keys are read from `/status` and accepted only if the id matches the listed peer. `threshold` comes from `config/peers.json`. `catchUp` restores a signed snapshot from an ahead peer. `UEP_PORT` is the API port.

## Concurrent spends

Votes for different notes travel at the same time. The apply is queued, one at a time, so two submits do not interleave. Two spends of one note still cannot both confirm.

## No wait for the third vote

A spend is sent and voted in one request. Confirmation happens when two votes are in, without waiting for the third. Confirm and apply are one step.

## After the 2026-10-10 Phase 4 audit

A nullifier is marked spent only after submit succeeds. A status id that does not match the listed peer is ignored. Catch-up restores. The peer timeout is 15 s.

## Catch-up by root

`catchUp` restores only from a peer that is ahead: higher height, or the same height with more committed transactions. A different root that is behind is ignored. It does not merge a fork. A repeated spend is `QUORUM_NULLIFIER_SPENT`.

## Duplicate settlement

Settling an order twice returns the same record and does not move balances. A restored marketplace keeps the receipt and the balances. This is local to the marketplace, not a cross-domain receipt.

## Clock drift

A node whose `Date.now` is pinned to 0 accepts the same client spend and reaches the same root. Validity is height and the signed spend, not the wall clock. That is the shape a domain with a drifted clock needs.

## Censorship until the window

A spend that never gets two votes does not lock the note. After the policy window the client spends it another way. The withheld spend is then rejected. This is local to the domain.

## Quorum survives restart

Votes are written to `quorum-votes.json` when `UEP_DATA_DIR` is set. A new process loads them and rejects a second vote for the same nullifier. A vote is also refused if the ledger has already committed that nullifier.

## Milestone: concurrent spends, 2026-10-10

Measured on one machine, three in-process peers, different notes.

| At once | Result |
|---|---|
| 2, 4, 8 | One root. |
| 12 | Flaky. One run left 11 of 12 and two roots. |
| 13 | Two runs converged. One left 12 and two roots. |
| 16 | Broke. 15 of 16, three roots. |

The failure is `QUORUM_NOT_MET`: a vote or a commit does not arrive, and the roots diverge. It is not a double spend. Eight is the last count that did not break in this measurement. This is the harness, not three machines.

## Milestone: concurrent spends, second cut

Applies yield between transactions. A lost vote or commit is retried. Timeout is 15 s.

| At once | Result |
|---|---|
| 8, 16, 24, 32, 48, 64 | One root. |

The previous cut broke at 16. Sixteen is now a regression test. Still one process, not three machines.

## Peer message authentication

`/tx`, `/vote` and `/commit` carry a signature over `uep-peer:id:path:payload`. The receiver checks it against the key learned for that listed id. An unsigned message is `PEER_AUTH`. `/status` stays unsigned so keys can be learned. `/snapshot` is already signed by the snapshot key.

## Partition and return

Two peers confirm while the third is closed. The third comes back from an older snapshot and `catchUp` restores the ahead root. It does not merge. This is one process with a closed socket, not a network split.

## Domain-bound votes

A quorum vote signs `uep-quorum:networkId:domainId:txId`. A vote from another domain does not confirm. The quorum stays inside the domain. A snapshot is what can cross later. This is the harness, not an interplanetary link.

## Voter keys are pinned

A key already known is not replaced by `/status`. If `config/peers.json` carries `publicKeyHex`, that is the pin and a different announcement is ignored. First contact without a pin can learn once. That is the harness, not the trust model.

## After the 2026-10-10 0.5.58 audit

`/vote` persists the vote. `confirmed` is stored with `voted` and `spent`. The shipped `peers.json` is addresses and a threshold; pins are added after the keys exist. Timeout is 15 s.

## Catch-up fails closed

If the ahead snapshot does not restore, `catchUp` returns false and keeps the local ledger. Startup does not crash on a bad snapshot.

## Commit acknowledgement

`propose` does not report success unless at least `threshold - 1` peers acknowledge the commit. A vote without an applied commit is `COMMIT_NOT_ACKED`. The local ledger may already hold the spend; the caller is not told it landed on the network.

## Local apply follows the network

The proposer applies only after `threshold - 1` peers acknowledge the commit. If they do not, the local ledger does not take the spend. A local spend means the network acknowledged it.

## Different local configuration

Three nodes with different fee accounts, admin ids and blinding domains accept the same client spend and reach the same root. That is the Phase 4 exit criterion on configuration. It is not the independent assessment.

## Ready for assessment

`docs/PHASE-4-ASSESSMENT.md` is the package. `npm run test:consensus` is the command. It is not the assessment.


## Real node meets the harness (0.5.69)

A peer validates a spend against its own ledger (`validateSpend`, read-only) before it votes, in `/tx` and in `propose`. A vote is remembered per nullifier and is never released, so an invalid spend that reuses a nullifier used to block the real one (`QUORUM_EQUIVOCATION`). It now gets no vote.

Each node signs snapshots and mints with its own keys. `config/peers.json` may pin them per peer (`snapshotPublicKeyHex`, `faucetPublicKeyHex`). A node trusts its own keys plus the pinned ones, to reopen its disk and to `catchUp`. A key that is not pinned has no weight, and `/status` never announces a snapshot authority. Without pins, `catchUp` returns false and keeps the local ledger.

Limit: one valid authority signature is enough, so `catchUp` trusts the one peer that serves the snapshot. A Byzantine pinned peer can serve a bad ledger. Closing that needs quorum evidence in the snapshot and is not this cut.

`cli.ts` runs `catchUp` before the node is assembled, so the API, queue, bridge and Marketplace serve the ledger that was kept. `catchUp` is a startup step: calling it later on a running node would leave the node on the old ledger.

A spend submitted through a node's own HTTP API (`/v1`) goes to its local ledger and does not go through the peer quorum. Only `/propose` does. Joining the two is a decision still open.
