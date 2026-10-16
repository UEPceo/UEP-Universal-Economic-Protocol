---------------------------- MODULE UepBftLocking ----------------------------
(***************************************************************************)
(* UEP 0.5.84 item 3: model of the locking rules, round changes and        *)
(* proposal selection of the BFT kernel (src/node/bft-consensus.ts) for ONE *)
(* height, n = 4 validators (3 honest, 1 Byzantine), quorum 2f+1 = 3.      *)
(*                                                                         *)
(* Asynchrony: votes are a growing set that any validator may observe at   *)
(* any time, so message loss, delay, duplication, reordering and           *)
(* partitions are covered by interleaving. The Byzantine validator's votes *)
(* count for every value at every round (worst case) and it may propose    *)
(* several values in a round it leads (leader equivocation).               *)
(* Crash/restart: with Persist = TRUE a restart keeps votes, locks and     *)
(* round changes (they are written before the signature is released, as   *)
(* in the kernel's persistState hook); with Persist = FALSE a restart      *)
(* forgets them, which TLC shows breaks Agreement.                         *)
(*                                                                         *)
(* Safety only: liveness (termination after GST) is not checked.           *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Values, MaxRound, Persist

Honest == {"a", "b", "c"}
Byz    == {"z"}
Q      == 3                 \* 2f + 1 with f = 1
Rounds == 0..MaxRound
None   == "none"
NoLock == [r |-> -1, v |-> None]
Leader(r) == CASE r % 4 = 0 -> "z" [] r % 4 = 1 -> "a" [] r % 4 = 2 -> "b" [] OTHER -> "c"

\* prevote/precommit: the validator's own durable record of what it signed (anti-equivocation memory).
\* pvMsgs/pcMsgs: signed votes in the network; once sent they stay observable forever.
VARIABLES round, prevote, precommit, lock, proposals, rc, restarts, pvMsgs, pcMsgs

vars == <<round, prevote, precommit, lock, proposals, rc, restarts, pvMsgs, pcMsgs>>

PrevoteQuorum(r, v)   == Cardinality({m.h : m \in {x \in pvMsgs : x.r = r /\ x.v = v}}) + Cardinality(Byz) >= Q
PrecommitQuorum(r, v) == Cardinality({m.h : m \in {x \in pcMsgs : x.r = r /\ x.v = v}}) + Cardinality(Byz) >= Q
Decided(v) == \E r \in Rounds : PrecommitQuorum(r, v)

\* A proposal is valid when its POL (validRound certificate) exists, as verifyProposal/createVote require.
\* (IF-THEN-ELSE: TLC explores every disjunct of an action, so a guard must not index round -1.)
ValidPol(p) == IF p.vr = -1 THEN TRUE ELSE (p.vr < p.r /\ PrevoteQuorum(p.vr, p.v))

TypeOK ==
  /\ round \in [Honest -> Rounds]
  /\ prevote \in [Honest -> [Rounds -> Values \cup {None}]]
  /\ precommit \in [Honest -> [Rounds -> Values \cup {None}]]
  /\ lock \in [Honest -> [r : {-1} \cup Rounds, v : Values \cup {None}]]
  /\ proposals \subseteq [r : Rounds, v : Values, vr : {-1} \cup Rounds]
  /\ rc \subseteq [h : Honest, target : Rounds, lr : {-1} \cup Rounds, lv : Values \cup {None}]
  /\ pvMsgs \subseteq [h : Honest, r : Rounds, v : Values]
  /\ pcMsgs \subseteq [h : Honest, r : Rounds, v : Values]

Init ==
  /\ round = [h \in Honest |-> 0]
  /\ prevote = [h \in Honest |-> [r \in Rounds |-> None]]
  /\ precommit = [h \in Honest |-> [r \in Rounds |-> None]]
  /\ lock = [h \in Honest |-> NoLock]
  /\ proposals = {}
  /\ rc = {}
  /\ restarts = 0
  /\ pvMsgs = {}
  /\ pcMsgs = {}

\* Byzantine leader: any value, any (possibly invalid) validRound; may equivocate.
ByzPropose(r, v, vr) ==
  /\ Leader(r) \in Byz
  /\ vr \in {-1} \cup 0..(r - 1)
  /\ proposals' = proposals \cup {[r |-> r, v |-> v, vr |-> vr]}
  /\ UNCHANGED <<round, prevote, precommit, lock, rc, restarts, pvMsgs, pcMsgs>>

\* Honest leader, requiredProposalFromRoundChanges: with a quorum of round-change messages for
\* this round, carry forward the highest reported lock (value + its round as validRound);
\* without reported locks (or in round 0) any value with validRound = -1.
HonestPropose(h, v) ==
  LET r == round[h]
      msgs == {m \in rc : m.target = r}
      locked == {m \in msgs : m.lr >= 0}
      hi == IF locked = {} THEN -1 ELSE CHOOSE x \in {m.lr : m \in locked} : \A y \in {m.lr : m \in locked} : x >= y
  IN /\ Leader(r) = h
     /\ ~\E p \in proposals : p.r = r
     /\ \/ r = 0 /\ proposals' = proposals \cup {[r |-> 0, v |-> v, vr |-> -1]}
        \/ /\ r > 0
           /\ Cardinality(msgs) + Cardinality(Byz) >= Q
           /\ IF hi = -1
                THEN proposals' = proposals \cup {[r |-> r, v |-> v, vr |-> -1]}
                ELSE \E m \in locked : m.lr = hi /\ m.lv = v /\ proposals' = proposals \cup {[r |-> r, v |-> v, vr |-> hi]}
     /\ UNCHANGED <<round, prevote, precommit, lock, rc, restarts, pvMsgs, pcMsgs>>

\* createVote(prevote): one prevote per round (anti-equivocation); a validator locked on another
\* value prevotes only with a valid POL from a round above its lock.
Prevote(h, p) ==
  /\ p \in proposals
  /\ p.r = round[h]
  /\ prevote[h][p.r] = None
  /\ ValidPol(p)
  /\ IF lock[h].r = -1 \/ lock[h].v = p.v THEN TRUE
     ELSE (p.vr > lock[h].r /\ PrevoteQuorum(p.vr, p.v))
  /\ prevote' = [prevote EXCEPT ![h][p.r] = p.v]
  /\ pvMsgs' = pvMsgs \cup {[h |-> h, r |-> p.r, v |-> p.v]}
  /\ UNCHANGED <<round, precommit, lock, proposals, rc, restarts, pcMsgs>>

\* observePrevoteCertificate: a 2f+1 prevote certificate raises the lock (never to a lower round;
\* another value at a round <= the lock's round is BFT_LOCK_CONFLICT and is ignored here).
ObservePol(h, r, v) ==
  /\ PrevoteQuorum(r, v)
  /\ r > lock[h].r
  /\ lock' = [lock EXCEPT ![h] = [r |-> r, v |-> v]]
  /\ UNCHANGED <<round, prevote, precommit, proposals, rc, restarts, pvMsgs, pcMsgs>>

\* createVote(precommit): requires the registered lock at exactly this round and value.
Precommit(h) ==
  LET r == round[h] IN
  /\ precommit[h][r] = None
  /\ lock[h].r = r
  /\ \E p \in proposals : p.r = r /\ p.v = lock[h].v
  /\ PrevoteQuorum(r, lock[h].v)
  /\ precommit' = [precommit EXCEPT ![h][r] = lock[h].v]
  /\ pcMsgs' = pcMsgs \cup {[h |-> h, r |-> r, v |-> lock[h].v]}
  /\ UNCHANGED <<round, prevote, lock, proposals, rc, restarts, pvMsgs>>

\* createRoundChange: target round must be above the lock's round; the message reports the lock.
RoundChange(h) ==
  LET t == round[h] + 1 IN
  /\ t <= MaxRound
  /\ t > lock[h].r
  /\ round' = [round EXCEPT ![h] = t]
  /\ rc' = rc \cup {[h |-> h, target |-> t, lr |-> lock[h].r, lv |-> lock[h].v]}
  /\ UNCHANGED <<prevote, precommit, lock, proposals, restarts, pvMsgs, pcMsgs>>

\* Crash and restart. Durable state survives only with Persist = TRUE.
\* With Persist = TRUE a restart leaves every modeled variable unchanged (votes, locks and round
\* changes are durable before signing; the current round is re-derived from them), i.e. it is a
\* stuttering step and is omitted. With Persist = FALSE the validator forgets them (at most 1 restart).
Restart(h) ==
  /\ ~Persist
  /\ restarts < 1
  /\ restarts' = restarts + 1
  /\ prevote' = [prevote EXCEPT ![h] = [r \in Rounds |-> None]]
  /\ precommit' = [precommit EXCEPT ![h] = [r \in Rounds |-> None]]
  /\ lock' = [lock EXCEPT ![h] = NoLock]
  /\ UNCHANGED <<round, proposals, rc, pvMsgs, pcMsgs>>

Next ==
  \/ \E r \in Rounds, v \in Values, vr \in {-1} \cup Rounds : ByzPropose(r, v, vr)
  \/ \E h \in Honest, v \in Values : HonestPropose(h, v)
  \/ \E h \in Honest, p \in proposals : Prevote(h, p)
  \/ \E h \in Honest, r \in Rounds, v \in Values : ObservePol(h, r, v)
  \/ \E h \in Honest : Precommit(h)
  \/ \E h \in Honest : RoundChange(h)
  \/ \E h \in Honest : Restart(h)

Spec == Init /\ [][Next]_vars

(* Safety properties *)
Agreement == \A v1, v2 \in Values : (Decided(v1) /\ Decided(v2)) => v1 = v2

\* An honest validator never prevotes or precommits two values in one round (holds by construction
\* of the vote maps; stated for the record) and its lock only moves up.
LockOnlyRises == [][\A h \in Honest : lock'[h].r >= lock[h].r \/ (~Persist)]_vars

\* A decided value is the lock of at least one honest validator at a round >= the deciding round.
DecidedIsLocked == \A v \in Values : \A r \in Rounds :
  PrecommitQuorum(r, v) => \E h \in Honest : lock[h].r >= r

\* With durable memory, an honest validator never has two different signed votes in one round.
NoHonestEquivocation == \A m1, m2 \in pvMsgs : (m1.h = m2.h /\ m1.r = m2.r) => m1.v = m2.v

=============================================================================
