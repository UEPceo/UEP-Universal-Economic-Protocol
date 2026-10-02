# P4 STAGING — UEP-38.4

Profile: `P4-STAGING-DEV`  (DEV Groth16 keys)

```
SMT Poseidon stateRoot (aligned IDs)
        ↓
prove-spend-json
        ↓
each replica: verify-hex
        ↓
public_0 == local stateRoot
        ↓
apply transfer
        ↓
public_1 == new stateRoot
        ↓
all replicas same root
```

DEMONSTRATED (test:p4-staging 3/3 PASS)
- 3 in-process replicas D=4
- honest path converges
- tampered proof: no apply

NOT PRODUCTION
- no ceremony
- no holds in SpendCircuit
- no TCP mesh on this path
- D=32 golden exists (38.1) but staging suite uses D=4 for wall time

## 38.5
- D=32: 2 replicas prove → verify-hex → same root (~22s)
- Artifact JSON (vk, proof, 12 publics, roots) is sufficient for a cold replica
- test:p4-staging 5/5 PASS

## 38.6 TCP mesh
Kind `P4_SPEND` over localhost TcpMeshEndpoint.
Follower verify-hex then apply. test:p4-mesh 2/2 PASS.
Still DEV keys. Not the 37.x BFT envelope.

## 38.7 signed PROPOSAL
zkSpend travels inside ConsensusEnvelope PROPOSAL (Ed25519).
Follower: verify envelope → verify-hex → apply.
37.x digest unchanged when zkSpend absent.
test:p4-bft 4/4 PASS.
Not yet: required on every 37.x ProcessCluster proposal.

## 38.8 quorum before apply
N=3, need 2 votes over payloadDigest.
Inspect = envelope sig + Groth16 against local root.
No vote ⇒ no apply. test:p4-quorum 3/3 PASS.

## 38.9 TCP quorum
P4_PROPOSAL / P4_VOTE / P4_COMMIT on TcpMeshEndpoint.
test:p4-qmesh 2/2 PASS. Commit idempotent if root already new.

## 38.10 one OS process per node
3 child processes, isolated SMT + keys.
stdin JSON control, TCP P4_PROPOSAL/VOTE/COMMIT.
test:p4-process 2/2 PASS (~8s D=4).
DEV keys. Not 37.x ProcessCluster.

## 38.11 solder 37 ↔ P4
P4 quorum = BFT-CLASSIC N=4 q=3.
ProposalPayload.zkSpend optional; digest 35.7.1 unchanged if absent.
Process-node tryVote: if zkSpend present → verify-hex; if UEP_REQUIRE_ZK_SPEND=1 missing → no vote.

## 38.12 Byzantine height lock
Honest replica: one payloadDigest per (epoch,height).
Second distinct proposal → HEIGHT_VOTE_LOCK_CONFLICT, no vote.
Same digest retry OK.
test:p4-byz 3/3. Catch-up + disk log closed in 38.13–38.16.

## 38.13 catch-up
Late replica applies certified {env, votes} without having voted.
Locks height to that digest afterwards (cannot vote a fork).
Process wire: P4_CATCHUP_REQ → peers rebroadcast last P4_COMMIT.
test:p4-byz 4/4.

## 38.14 process respawn
Kill replica → new process at genesis → P4_CATCHUP_REQ → peer lastCommit → same root.
test:p4-process 3/3.

## 38.15 last-commit.json
Each process writes last-commit.json after apply.
Cold start with UEP_P4_DATA_DIR reapplies the certified spend onto genesis.
No live peer required. One height only (lab).
test:p4-process 4/4.

## 38.16 review closure
Fixed: applied-boolean blocking height 2; TX_REPLAY (tx id uep38-seq-amount);
out-of-order COMMIT buffer; votes before PROPOSAL; commits.jsonl chain.
Still later: P4 view-change, D=32 process, holds in circuit, ceremony.
test:p4-process 5/5, test:p4-byz 4/4, test:p4-quorum 3/3.

## 38.16 review closure
Multi-height commits.jsonl, unique apply ids, vote/commit buffers.
test:p4-process 5/5.

## 38.17 P4 view-change
QC 37.7.2, N=4 q=3. View without QC rejected. After commit, view resets.
test:p4-view 3/3.

## 38.18 VIEW_CHANGE on process TCP mesh
P4_VIEW_CHANGE votes, QC 2f+1, view_adopted, NOT_LEADER, new leader proposes.
Catch-up still used if a replica misses PROPOSAL.
test:p4-vmesh + test:p4-view 5/5.

## 38.19 mesh peer dedup
Bidirectional TCP no longer drops the live socket on duplicate close.
Proposal/commit reach all replicas without flush. test:p4-vmesh all-4 apply PASS.

## 38.20 two disjoint spends, one height
Native chain of witnesses, two Groth16 in parallel, four replicas same root.
D=32. test:p4-batch 2/2 PASS. Poseidon unchanged.

## 38.21 hardening
commit/catchUp verify envelope digest+sig+leader. Vote binds epoch/view/network. VK pin. Structural SMT collision throws. MAC hex exact. Mesh id after construct. verify-hex timeout and ok=true line. /tmp/uep-zk no longer preferred.
7/7 PASS.

## 38.22 N-spend batch
proveManyParallel: N disjoint spends, native intermediate roots, Groth16 pool of 2.
Test: alice 1000, carol 700, erin 400. Four independent replicas same root. Bob/Dave/Frank balances match. 2/2 PASS. Wall about 87s on this host.
Three proves at once failed on this host (first Groth16 died). Pool of 2 is the lab limit, not a protocol limit.

## 38.26 P4 spend cert
Network apply waits for 3 Ed25519 signatures from p4 replica keys over spendId|newRoot|proofHash. Two signatures do not apply. A signature over another root does not count.

## 38.27 mesh spend cert
Four OS processes. Propose, TCP votes carry spendCertSig from p4 replica keys, apply waits for 3, same root. 1/1 PASS.

## 38.28 laggard
p4-3 stays off the mesh during propose. It misses the proposal. After reconnect, catch-up/flush delivers the certified commit. Same root, no second proof. 1/1 PASS.

## 38.29 laggard restart
Missed proposal, killed, empty disk, respawn joins only itself, certified commit, same root. 1/1 PASS.
