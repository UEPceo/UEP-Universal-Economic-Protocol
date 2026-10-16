# BFT kernel: TLA+ model and mapping to an identified specification (0.5.84, item 3)

Status: Experimental (lab). The model checks **safety for one height** under the assumptions below. It is not a proof for unbounded rounds, and it says nothing about liveness or about a real network.

## Reference specification

Primary reference: **Tendermint**, E. Buchman, J. Kwon, Z. Milosevic, *The latest gossip on BFT consensus*, arXiv:1807.04938 (2018), Algorithm 1 (proposal / prevote / precommit, `lockedValue`/`lockedRound`, `validValue`/`validRound`). The round-change messages follow the **QBFT / IBFT 2.0** pattern (signed ROUND-CHANGE carrying the highest prepared certificate, and a round-change quorum that justifies the next proposal; see Saltini & Hyland-Wood, *IBFT 2.0: A Safe and Live Variation of the IBFT Blockchain Consensus Protocol for Eventually Synchronous Networks*, arXiv:1909.10194).

## Model

`docs/formal/tla/UepBftLocking.tla`, checked with TLC 1.8.0 (`tla2tools.jar`, OpenJDK 21). n = 4 (3 honest, 1 Byzantine), quorum 3, values {v1, v2}.

- Asynchrony: signed votes are sets that any validator may observe at any time; loss, delay, duplication, reordering and partitions are interleavings.
- Byzantine validator: its votes count for every value at every round; as leader it can propose several values with any validRound (leader equivocation).
- Crash/restart: with `Persist = TRUE` votes, locks and round changes are durable before signing (the kernel's `persistState` hook, now frames of the unified store); a restart is then a stuttering step. With `Persist = FALSE` (negative control) a restart forgets them.

| Run | Config | Result | States (distinct) | Output |
|---|---|---|---|---|
| Rounds 0..1, durable | `UepBftLocking_R1.cfg` | No error | see `out/tlc-persist-r1.txt` | `out/tlc-persist-r1.txt` |
| Rounds 0..2, durable | `UepBftLocking.cfg` | see RESOLUTION | see output | `out/tlc-persist-r2.txt` |
| Rounds 0..1, no durability | `UepBftLocking_NoPersist.cfg` | **Agreement violated** (expected; counterexample trace) | — | `out/tlc-nopersist.txt` |

Invariants: `TypeOK`, `Agreement` (no two values decided at one height), `DecidedIsLocked`, `NoHonestEquivocation`; temporal property `LockOnlyRises`.

Reproduce: `cd docs/formal/tla/out && java -cp tla2tools.jar tlc2.TLC -workers 6 -deadlock -config ../UepBftLocking.cfg ../UepBftLocking.tla`.

## Correspondence

| Implementation (`src/node/bft-consensus.ts`) | TLA+ action | Tendermint / QBFT | Notes |
|---|---|---|---|
| `leader(height, round)` round-robin | `Leader(r)` | `proposer(h, r)` | same |
| `signProposal`, `verifyProposal` (validRound + validRoundCertificate) | `HonestPropose`, `ByzPropose`, `ValidPol` | `PROPOSAL⟨h, r, v, vr⟩` with POL for `vr` | |
| `requiredProposalFromRoundChanges` | `HonestPropose` (r > 0) | QBFT round-change justification (highest prepared) / Tendermint `validValue` | **Deviation D1** |
| `createVote(prevote)` lock rule (`BFT_LOCKED_CONFLICTING_PREVOTE`) | `Prevote` | lines 22–33 of Algorithm 1 | prevote only for the lock value or with a POL at `vr > lockedRound` |
| `observePrevoteCertificate` | `ObservePol` | `lockedRound/lockedValue` update on 2f+1 prevotes | **Deviation D2** |
| `createVote(precommit)` (`BFT_PRECOMMIT_REQUIRES_REGISTERED_LOCK`) | `Precommit` | lines 36–43 | precommit only with the lock registered at exactly this round |
| `createRoundChange`, `verifyRoundChange`, `roundChangeCertificate` | `RoundChange` | QBFT ROUND-CHANGE | **Deviation D3** |
| anti-equivocation maps + `persistState` before signing | `prevote`/`precommit` memory, `Persist` | — | durability is assumed by Tendermint; here it is explicit and tested (item 1) |
| `recordCommit`, certified-commit journal | `Decided(v)` / `PrecommitQuorum` | decision on 2f+1 precommits | application to the ledger is separate (ADR 0007) |

## Deviations

- **D1 — proposal selection.** A new-round leader must carry the highest lock reported in a 2f+1 round-change certificate (QBFT style) rather than its own `validValue` (Tendermint). Safety does not depend on it in the model (the prevote rule protects locked validators); it affects liveness.
- **D2 — lock source.** A validator may raise its lock from any verified prevote certificate of a higher round, not only in the current round's step. The model allows this (`ObservePol` for any round) and Agreement still holds in the checked bounds.
- **D3 — no nil votes.** Timeouts produce signed round-change messages instead of nil prevotes/precommits. A round-change target must be above the sender's lock round.
- **D4 — bounded check.** Rounds are bounded (0..2), one height, one Byzantine validator, two values. Larger bounds were not checked (state explosion); see the residual items.
- **D5 — not modelled.** Liveness after GST, validator-set changes (epochs), the 0.5.80 legacy vote format, slashing/penalties (none exist), message authentication (assumed by signatures).

## Adversarial multi-process tests (implementation side)

`npm run test:bft-adversarial`: `bft-recovery-multiprocess.test.ts` (equivocating leader with evidence, automatic round change, loss/duplication/delay, 2 | 2 partition, SIGKILL restarts), `bft-crash-points-multiprocess.test.ts` (7 write points, now on the unified store), `bft-unified-store-multiprocess.test.ts`, `bft-checkpoint-multiprocess.test.ts`. One machine, loopback fault proxies.
