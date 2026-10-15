//! Tests for circuit v6 (0.5.83): regression, differential circuit ⇔ predicate,
//! free-variable probe, non-vacuity, migration.

use super::*;
use crate::spend_circuit::{SpendCircuit, SpendLayout};
use ark_relations::r1cs::{
    ConstraintSynthesizer, ConstraintSystem, ConstraintSystemRef, SynthesisError,
};
use rand::{rngs::StdRng, Rng, SeedableRng};

type P = UepPoseidon;

fn sat<const D: usize>(c: &SpendCircuit<D>) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    match c.clone().generate_constraints(cs.clone()) {
        Ok(()) => cs.is_satisfied().unwrap_or(false),
        Err(_) => false,
    }
}

fn treasury_id() -> Fr {
    Fr::from(100u64)
}

/// Seed a sender leaf (and optionally recipient/treasury leaves) into trees.
fn seed<H: SpendHash, const D: usize>(
    trees: &mut SpendTrees<H, D>,
    owner: Fr,
    asset: Fr,
    bal: u64,
    blind: Fr,
) {
    let idx = state_index::<H>(owner, asset, D);
    trees.state.set(idx, note_commitment::<H>(owner, asset, Fr::from(bal), blind));
}

/// Accounts whose (account, asset) slots and treasury slot are pairwise distinct at depth D.
fn distinct_accounts<H: SpendHash, const D: usize>(asset: Fr, n: usize) -> Vec<(Fr, Fr, Fr)> {
    let t_idx = state_index::<H>(treasury_id(), asset, D);
    let mut used = vec![t_idx];
    let mut out = Vec::new();
    let mut k = 1u64;
    while out.len() < n {
        let secret = Fr::from(1000 + k);
        let salt = Fr::from(77u64);
        let id = h_account::<H>(secret, salt);
        let idx = state_index::<H>(id, asset, D);
        if !used.contains(&idx) {
            used.push(idx);
            out.push((secret, salt, id));
        }
        k += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// F1 regression: balance returning to an earlier value
// ---------------------------------------------------------------------------

/// Plays: A(10 000) → B 1 000 (fee 1, A = 8 999); B → A 1 001 (A = 10 000 again);
/// A spends again. Returns (nf1, nf2, A's leaf before spend 1, A's leaf before spend 2,
/// result of building the second spend).
fn return_to_prior_balance(layout: SpendLayout) -> (Fr, Fr, Fr, Fr, Result<BuiltSpend<P, 8>, String>, SpendTrees<P, 8>) {
    let asset = Fr::from(1u64);
    let acc = distinct_accounts::<P, 8>(asset, 2);
    let (a_sec, a_salt, a_id) = acc[0];
    let (b_sec, b_salt, b_id) = acc[1];
    let a_blind = Fr::from(3u64);
    let b_blind = Fr::from(4u64);
    let t_blind = Fr::from(5u64);
    let mut trees = SpendTrees::<P, 8>::new();
    seed(&mut trees, a_id, asset, 10_000, a_blind);
    seed(&mut trees, b_id, asset, 1_000, b_blind);
    seed(&mut trees, treasury_id(), asset, 0, t_blind);
    let a_leaf1 = trees.state.get_leaf(state_index::<P>(a_id, asset, 8));
    let s1 = build_spend::<P, 8>(&trees, &SpendParams {
        secret: a_sec, salt: a_salt, sender_blinding: a_blind, sender_old_balance: 10_000,
        recipient: Party { id: b_id, blinding: b_blind, old_balance: 1_000 },
        treasury: Party { id: treasury_id(), blinding: t_blind, old_balance: 0 },
        asset, amount: 1_000, domain_id: 1,
    }, layout).unwrap();
    assert!(sat(&s1.circuit));
    let nf1 = s1.circuit.nullifier;
    let a_blind2 = s1.sender_next_blinding;
    // A: 8 999. B: 2 000. B pays A 1 001 (fee 1): A = 10 000, B = 998.
    let s2 = build_spend::<P, 8>(&s1.trees, &SpendParams {
        secret: b_sec, salt: b_salt, sender_blinding: b_blind, sender_old_balance: 2_000,
        recipient: Party { id: a_id, blinding: a_blind2, old_balance: 8_999 },
        treasury: Party { id: treasury_id(), blinding: t_blind, old_balance: 1 },
        asset, amount: 1_001, domain_id: 1,
    }, layout).unwrap();
    assert!(sat(&s2.circuit));
    let a_leaf2 = s2.trees.state.get_leaf(state_index::<P>(a_id, asset, 8));

    // A spends again from 10 000.
    let p3 = SpendParams {
        secret: a_sec, salt: a_salt, sender_blinding: a_blind2, sender_old_balance: 10_000,
        recipient: Party { id: b_id, blinding: s2.sender_next_blinding, old_balance: 998 },
        treasury: Party { id: treasury_id(), blinding: t_blind, old_balance: 2 },
        asset, amount: 500, domain_id: 1,
    };
    let nf2 = {
        let s_old = note_commitment::<P>(h_account::<P>(a_sec, a_salt), asset, Fr::from(10_000u64), a_blind2);
        h_nullifier::<P>(a_sec, note_nonce::<P>(s_old, a_blind2))
    };
    let s3 = build_spend::<P, 8>(&s2.trees, &p3, layout);
    (nf1, nf2, a_leaf1, a_leaf2, s3, s2.trees)
}

#[test]
fn f1_legacy_repeats_nullifier_and_blocks_spend_with_real_poseidon() {
    let (nf1, nf2, leaf1, leaf2, s3, trees) = return_to_prior_balance(SpendLayout::V5Legacy);
    assert_eq!(nf1, nf2, "v5: same balance + same blinding → same nullifier");
    assert_eq!(leaf1, leaf2, "v5: the two leaves are identical (linkable)");
    let err = s3.err().expect("v5: second spend must not be buildable");
    assert!(err.contains("NULLIFIER_SLOT_OCCUPIED"), "{err}");
    // And no witness exists: the circuit with the real nullifier root is unsatisfied.
    let mut fresh = trees.clone();
    fresh.nullifiers = NativeSmt::new();
    let asset = Fr::from(1u64);
    let forced = {
        // Build against an empty nullifier tree, then bind the real one.
        let acc = distinct_accounts::<P, 8>(asset, 2);
        let (a_sec, a_salt, _) = acc[0];
        let (_, _, b_id) = acc[1];
        let p = SpendParams {
            secret: a_sec, salt: a_salt, sender_blinding: Fr::from(3u64), sender_old_balance: 10_000,
            recipient: Party { id: b_id, blinding: Fr::from(4u64), old_balance: 998 },
            treasury: Party { id: treasury_id(), blinding: Fr::from(5u64), old_balance: 2 },
            asset, amount: 500, domain_id: 1,
        };
        build_spend::<P, 8>(&fresh, &p, SpendLayout::V5Legacy).unwrap().circuit
    };
    assert!(sat(&forced), "control: provable against an empty nullifier tree");
    let mut blocked = forced.clone();
    blocked.old_nullifier_root = trees.nullifiers.root();
    let (sibs, _) = trees.nullifiers.path(blocked.nullifier_index);
    blocked.nullifier_siblings.copy_from_slice(&sibs);
    assert!(!sat(&blocked), "v5: no witness with the real nullifier tree");
}

#[test]
fn f1_v6_rotation_gives_fresh_nullifier_and_unlinkable_leaf() {
    let (nf1, nf2, leaf1, leaf2, s3, _) = return_to_prior_balance(SpendLayout::V6);
    assert_ne!(nf1, nf2, "v6: rotated blinding → different nullifier");
    assert_ne!(leaf1, leaf2, "v6: same balance, different leaf");
    let s3 = s3.expect("v6: second spend buildable");
    assert_eq!(s3.circuit.nullifier, nf2);
    assert!(sat(&s3.circuit), "v6: second spend provable");
    assert!(spend_valid::<P, 8>(&s3.circuit));
}

#[test]
fn v6_long_chain_has_distinct_nullifiers() {
    // A and B bounce the same amounts back and forth; balances repeat every 2 rounds.
    let asset = Fr::from(9u64);
    let acc = distinct_accounts::<P, 6>(asset, 2);
    let mut trees = SpendTrees::<P, 6>::new();
    let mut blind = [Fr::from(11u64), Fr::from(12u64)];
    let mut bal = [5_000u64, 5_000u64];
    let t_blind = Fr::from(13u64);
    let mut t_bal = 0u64;
    seed(&mut trees, acc[0].2, asset, bal[0], blind[0]);
    seed(&mut trees, acc[1].2, asset, bal[1], blind[1]);
    let mut nfs = Vec::new();
    for round in 0..8 {
        let (s, r) = if round % 2 == 0 { (0, 1) } else { (1, 0) };
        // r opens the treasury slot on round 0 (empty slot path)
        let built = build_spend::<P, 6>(&trees, &SpendParams {
            secret: acc[s].0, salt: acc[s].1, sender_blinding: blind[s], sender_old_balance: bal[s],
            recipient: Party { id: acc[r].2, blinding: blind[r], old_balance: bal[r] },
            treasury: Party { id: treasury_id(), blinding: t_blind, old_balance: t_bal },
            asset, amount: 1_000, domain_id: 1,
        }, SpendLayout::V6).unwrap();
        assert!(sat(&built.circuit), "round {round}");
        assert_eq!(built.circuit.treasury_slot_empty, round == 0);
        nfs.push(built.circuit.nullifier);
        blind[s] = built.sender_next_blinding;
        bal[s] -= 1_001;
        bal[r] += 1_000;
        t_bal += 1;
        trees = built.trees;
    }
    let mut sorted = nfs.clone();
    sorted.sort_by_key(|f| f.into_repr());
    sorted.dedup();
    assert_eq!(sorted.len(), nfs.len(), "all nullifiers distinct");
}

// ---------------------------------------------------------------------------
// Empty receiving slot
// ---------------------------------------------------------------------------

#[test]
fn pay_to_empty_recipient_slot() {
    let asset = Fr::from(1u64);
    let acc = distinct_accounts::<P, 8>(asset, 2);
    let mut trees = SpendTrees::<P, 8>::new();
    seed(&mut trees, acc[0].2, asset, 10_000, Fr::from(3u64));
    seed(&mut trees, treasury_id(), asset, 0, Fr::from(5u64));
    let p = SpendParams {
        secret: acc[0].0, salt: acc[0].1, sender_blinding: Fr::from(3u64), sender_old_balance: 10_000,
        recipient: Party { id: acc[1].2, blinding: Fr::from(4u64), old_balance: 0 },
        treasury: Party { id: treasury_id(), blinding: Fr::from(5u64), old_balance: 0 },
        asset, amount: 1_000, domain_id: 1,
    };
    // v5 had no way to open an empty slot (old leaf 0 ≠ commitment of balance 0).
    let e = build_spend::<P, 8>(&trees, &p, SpendLayout::V5Legacy).err().unwrap();
    assert!(e.contains("EMPTY_SLOT_NOT_SUPPORTED_IN_V5"), "{e}");
    let built = build_spend::<P, 8>(&trees, &p, SpendLayout::V6).unwrap();
    assert!(built.circuit.recipient_slot_empty);
    assert_eq!(built.circuit.recipient_old_leaf, Fr::from(0u64));
    assert!(sat(&built.circuit));
    assert!(spend_valid::<P, 8>(&built.circuit));
    // The recipient can then spend what it received (it knows its blinding).
    let next = build_spend::<P, 8>(&built.trees, &SpendParams {
        secret: acc[1].0, salt: acc[1].1, sender_blinding: Fr::from(4u64), sender_old_balance: 1_000,
        recipient: Party { id: acc[0].2, blinding: built.sender_next_blinding, old_balance: 8_999 },
        treasury: Party { id: treasury_id(), blinding: Fr::from(5u64), old_balance: 1 },
        asset, amount: 100, domain_id: 1,
    }, SpendLayout::V6).unwrap();
    assert!(sat(&next.circuit));

    // Negative: empty flag with a non-zero old balance.
    let mut bad = built.circuit.clone();
    bad.recipient_old_amount = Fr::from(1u64);
    bad.recipient_new_amount = Fr::from(1_001u64);
    assert!(!sat(&bad));
    assert!(!spend_valid::<P, 8>(&bad));
    // Negative: claim "empty" for a slot that holds a leaf.
    let mut trees2 = trees.clone();
    seed(&mut trees2, acc[1].2, asset, 0, Fr::from(4u64));
    let occupied = build_spend::<P, 8>(&trees2, &p, SpendLayout::V6).unwrap();
    assert!(!occupied.circuit.recipient_slot_empty);
    let mut lie = occupied.circuit.clone();
    lie.recipient_slot_empty = true;
    lie.recipient_old_leaf = Fr::from(0u64);
    assert!(!sat(&lie), "an occupied slot cannot be proven empty");
    assert!(!spend_valid::<P, 8>(&lie));
}

// ---------------------------------------------------------------------------
// Differential: circuit ⇔ native predicate (Poseidon, small D, both directions)
// ---------------------------------------------------------------------------

fn random_honest<const D: usize>(rng: &mut StdRng, layout: SpendLayout) -> SpendCircuit<D> {
    let asset = Fr::from(rng.gen_range(1u64..4));
    let acc = distinct_accounts::<P, D>(asset, 2);
    let mut trees = SpendTrees::<P, D>::new();
    let s_blind = Fr::from(rng.gen::<u64>());
    let r_blind = Fr::from(rng.gen::<u64>());
    let t_blind = Fr::from(rng.gen::<u64>());
    let s_bal = rng.gen_range(2_000u64..5_000_000);
    let r_empty = layout == SpendLayout::V6 && rng.gen_bool(0.3);
    let t_empty = layout == SpendLayout::V6 && rng.gen_bool(0.3);
    let r_bal = if r_empty { 0 } else { rng.gen_range(0u64..1_000_000) };
    let t_bal = if t_empty { 0 } else { rng.gen_range(0u64..1_000) };
    seed(&mut trees, acc[0].2, asset, s_bal, s_blind);
    if !r_empty { seed(&mut trees, acc[1].2, asset, r_bal, r_blind); }
    if !t_empty { seed(&mut trees, treasury_id(), asset, t_bal, t_blind); }
    // a few unrelated nullifiers
    for _ in 0..rng.gen_range(0..3) {
        let n = Fr::from(rng.gen::<u64>()) * Fr::from(1_000_003u64);
        trees.nullifiers.set(low_bits_u64(n, D), n);
    }
    let amount = rng.gen_range(1u64..(s_bal / 2));
    let p = SpendParams {
        secret: acc[0].0, salt: acc[0].1, sender_blinding: s_blind, sender_old_balance: s_bal,
        recipient: Party { id: acc[1].2, blinding: r_blind, old_balance: r_bal },
        treasury: Party { id: treasury_id(), blinding: t_blind, old_balance: t_bal },
        asset, amount, domain_id: rng.gen_range(1u64..3),
    };
    match build_spend::<P, D>(&trees, &p, layout) {
        Ok(b) => b.circuit,
        // nullifier slot taken by a random one: retry
        Err(_) => random_honest::<D>(rng, layout),
    }
}

fn bump(x: &mut Fr) {
    *x += Fr::from(1u64);
}

/// Apply mutation `k` (0..N_MUT). Some keep the spend valid (re-derive dependent values),
/// most break exactly one rule.
const N_MUT: usize = 34;
fn mutate<const D: usize>(c: &mut SpendCircuit<D>, k: usize, rng: &mut StdRng) {
    let one = Fr::from(1u64);
    match k {
        0 => bump(&mut c.old_state_root),
        1 => bump(&mut c.new_state_root),
        2 => bump(&mut c.old_nullifier_root),
        3 => bump(&mut c.new_nullifier_root),
        4 => bump(&mut c.sender_id),
        5 => bump(&mut c.recipient_id),
        6 => bump(&mut c.amount),
        7 => bump(&mut c.fee),
        8 => bump(&mut c.nullifier),
        9 => bump(&mut c.transaction_commitment),
        10 => bump(&mut c.domain_id),
        11 => bump(&mut c.sender_secret),
        12 => bump(&mut c.note_blinding),
        13 => bump(&mut c.note_nonce),
        14 => bump(&mut c.sender_new_blinding),
        15 => { c.sender_new_blinding = c.note_blinding; } // v5 behaviour inside v6: rejected
        16 => { c.sender_new_amount += one; c.recipient_new_amount -= one; } // conserves sum, breaks equations
        17 => bump(&mut c.mid_root_after_sender),
        18 => bump(&mut c.mid_root_after_recipient),
        19 => { let i = rng.gen_range(0..D); c.sender_siblings[i] += one; }
        20 => { let i = rng.gen_range(0..D); c.recipient_siblings[i] += one; }
        21 => { let i = rng.gen_range(0..D); c.treasury_siblings[i] += one; }
        22 => { let i = rng.gen_range(0..D); c.nullifier_siblings[i] += one; }
        23 => { let i = rng.gen_range(0..D); c.sender_index_bits[i] = !c.sender_index_bits[i]; }
        24 => { c.recipient_index ^= 1; c.recipient_index_bits[0] = !c.recipient_index_bits[0]; }
        25 => { c.nullifier_index |= 1u64 << D.min(63); } // index above 2^D
        26 => { c.recipient_slot_empty = !c.recipient_slot_empty; }
        27 => { c.treasury_slot_empty = !c.treasury_slot_empty; }
        28 => bump(&mut c.recipient_blinding),
        29 => bump(&mut c.treasury_blinding),
        30 => bump(&mut c.sender_old_leaf),
        31 => bump(&mut c.nullifier_leaf),
        32 => { c.treasury_old_amount += one; c.treasury_new_amount += one; }
        33 => { /* identity: stays valid */ }
        _ => unreachable!(),
    }
}

fn differential<const D: usize>(layout: SpendLayout, seed: u64, cases: usize) -> (usize, usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let (mut both_true, mut both_false) = (0, 0);
    for case in 0..cases {
        let mut c = random_honest::<D>(&mut rng, layout);
        assert!(sat(&c) && spend_valid::<P, D>(&c), "honest case {case} must pass both");
        both_true += 1;
        let nm = rng.gen_range(1..=2);
        let mut ks = Vec::new();
        for _ in 0..nm {
            let k = rng.gen_range(0..N_MUT);
            ks.push(k);
            mutate(&mut c, k, &mut rng);
        }
        let a = sat(&c);
        let b = spend_valid::<P, D>(&c);
        assert_eq!(a, b, "case {case}: circuit={a} predicate={b} after mutations {ks:?} ({layout:?})");
        if a { both_true += 1 } else { both_false += 1 }
    }
    (both_true, both_false)
}

#[test]
fn differential_v6_poseidon_d4() {
    let (t, f) = differential::<4>(SpendLayout::V6, 0x0583, 120);
    assert!(t >= 120 && f > 60, "both directions exercised: true={t} false={f}");
}

#[test]
fn differential_v6_poseidon_d5() {
    let (t, f) = differential::<5>(SpendLayout::V6, 0x5eed, 60);
    assert!(t >= 60 && f > 30, "true={t} false={f}");
}

#[test]
fn differential_v5_legacy_poseidon_d4() {
    let (t, f) = differential::<4>(SpendLayout::V5Legacy, 0x0005, 60);
    assert!(t >= 60 && f > 30, "true={t} false={f}");
}

#[test]
fn differential_every_mutation_once() {
    // Deterministic sweep: each single mutation on the same honest v6 spend.
    let mut rng = StdRng::seed_from_u64(7);
    let base = random_honest::<4>(&mut rng, SpendLayout::V6);
    let mut rejected = 0;
    for k in 0..N_MUT {
        let mut c = base.clone();
        mutate(&mut c, k, &mut rng);
        let (a, b) = (sat(&c), spend_valid::<P, 4>(&c));
        assert_eq!(a, b, "mutation {k}");
        if !a { rejected += 1 }
    }
    // every mutation except the identity (33) and possibly flag flips on a matching slot must reject
    assert!(rejected >= N_MUT - 3, "rejected {rejected} of {N_MUT}");
}

// ---------------------------------------------------------------------------
// Free-variable probe (finalized constraint system) with a positive control
// ---------------------------------------------------------------------------

/// Spend circuit plus `extra_free` unconstrained witnesses (positive control).
struct WithFree<const D: usize> {
    inner: SpendCircuit<D>,
    extra_free: usize,
}
impl<const D: usize> ConstraintSynthesizer<Fr> for WithFree<D> {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        use ark_r1cs_std::{alloc::AllocVar, fields::fp::FpVar};
        self.inner.generate_constraints(cs.clone())?;
        for i in 0..self.extra_free {
            let _ = FpVar::new_witness(cs.clone(), || Ok(Fr::from(9_000 + i as u64)))?;
        }
        Ok(())
    }
}

/// Returns the witness indices whose value can change without breaking any constraint.
fn free_witnesses<C: ConstraintSynthesizer<Fr>>(c: C) -> (Vec<usize>, usize) {
    let cs = ConstraintSystem::<Fr>::new_ref();
    c.generate_constraints(cs.clone()).unwrap();
    cs.finalize();
    assert!(cs.is_satisfied().unwrap(), "probe needs a satisfied base");
    let n = cs.num_witness_variables();
    let mut free = Vec::new();
    for i in 0..n {
        let orig = cs.borrow().unwrap().witness_assignment[i];
        let mut found_free = true;
        for delta in [Fr::from(1u64), Fr::from(2u64) - Fr::from(5u64)] {
            cs.borrow_mut().unwrap().witness_assignment[i] = orig + delta;
            if !cs.is_satisfied().unwrap() {
                found_free = false;
            }
            cs.borrow_mut().unwrap().witness_assignment[i] = orig;
            if !found_free {
                break;
            }
        }
        if found_free {
            free.push(i);
        }
    }
    (free, n)
}

#[test]
#[ignore = "nightly: single-threaded probe, >20 min; exp094 runs the parallel version"]
fn free_variable_probe_v6_poseidon_d3() {
    let mut rng = StdRng::seed_from_u64(31);
    let c = random_honest::<3>(&mut rng, SpendLayout::V6);
    let (free, n) = free_witnesses(c.clone());
    assert!(n > 1_000, "non-trivial witness count {n}");
    assert!(free.is_empty(), "unconstrained witnesses in v6: {free:?} of {n}");
    // Positive control: two deliberately free witnesses must be found, and only those.
    let (free_ctl, n_ctl) = free_witnesses(WithFree { inner: c, extra_free: 2 });
    assert_eq!(free_ctl, vec![n_ctl - 2, n_ctl - 1], "probe must detect the planted free witnesses");
}

#[test]
#[ignore = "nightly: single-threaded probe, >20 min; exp094 runs the parallel version"]
fn free_variable_probe_v6_empty_slots_d3() {
    // Same probe on the empty-slot branch (both receiving slots empty).
    let mut rng = StdRng::seed_from_u64(99);
    let mut c;
    loop {
        c = random_honest::<3>(&mut rng, SpendLayout::V6);
        if c.recipient_slot_empty && c.treasury_slot_empty { break; }
    }
    let (free, n) = free_witnesses(c);
    assert!(free.is_empty(), "unconstrained witnesses: {free:?} of {n}");
}

// ---------------------------------------------------------------------------
// Non-vacuity
// ---------------------------------------------------------------------------

#[test]
fn non_vacuity_examples() {
    // Each v6 feature has at least one satisfying instance, and the system is not empty.
    let mut rng = StdRng::seed_from_u64(1234);
    let mut seen = [false; 4]; // [plain, r_empty, t_empty, both]
    for _ in 0..200 {
        let c = random_honest::<4>(&mut rng, SpendLayout::V6);
        let i = match (c.recipient_slot_empty, c.treasury_slot_empty) {
            (false, false) => 0, (true, false) => 1, (false, true) => 2, (true, true) => 3,
        };
        if !seen[i] {
            let cs = ConstraintSystem::<Fr>::new_ref();
            c.clone().generate_constraints(cs.clone()).unwrap();
            assert!(cs.num_constraints() > 10_000);
            assert!(cs.is_satisfied().unwrap());
            assert!(spend_valid::<P, 4>(&c));
            assert_ne!(c.sender_new_blinding, c.note_blinding, "rotation is not the identity");
            seen[i] = true;
        }
        if seen.iter().all(|x| *x) { break; }
    }
    assert!(seen.iter().all(|x| *x), "all branches reached: {seen:?}");
    // The predicate is not trivially true: a single-field change is rejected.
    let mut c = random_honest::<4>(&mut rng, SpendLayout::V6);
    c.sender_new_blinding += Fr::from(1u64);
    assert!(!spend_valid::<P, 4>(&c) && !sat(&c));
}

// ---------------------------------------------------------------------------
// Migration and compatibility
// ---------------------------------------------------------------------------

#[test]
fn migrate_v5_d32_snapshot_to_d64_and_spend_old_leaf_under_v6() {
    let asset = Fr::from(1u64);
    let acc = distinct_accounts::<P, 64>(asset, 2);
    let entries = vec![
        BalanceEntry { account: acc[0].2, asset, leaf: note_commitment::<P>(acc[0].2, asset, Fr::from(10_000u64), Fr::from(3u64)) },
        BalanceEntry { account: acc[1].2, asset, leaf: note_commitment::<P>(acc[1].2, asset, Fr::from(50u64), Fr::from(4u64)) },
        BalanceEntry { account: treasury_id(), asset, leaf: note_commitment::<P>(treasury_id(), asset, Fr::from(0u64), Fr::from(5u64)) },
    ];
    let mut d32 = NativeSmt::<P, 32>::new();
    for e in &entries { d32.set(state_index::<P>(e.account, e.asset, 32), e.leaf); }
    let old_nfs = vec![Fr::from(123_456_789u64), Fr::from(987_654_321u64)];
    let mut nf32 = NativeSmt::<P, 32>::new();
    for n in &old_nfs { nf32.set(low_bits_u64(*n, 32), *n); }

    let state = migrate_state_d32_to_d64(&entries, Some(d32.root())).unwrap();
    let nullifiers = migrate_nullifiers_d32_to_d64(&old_nfs, Some(nf32.root())).unwrap();
    // incomplete or altered snapshot is refused
    assert!(migrate_state_d32_to_d64(&entries[..2], Some(d32.root())).is_err());
    assert!(migrate_nullifiers_d32_to_d64(&old_nfs[..1], Some(nf32.root())).is_err());
    for e in &entries {
        assert_eq!(state.get_leaf(state_index::<P>(e.account, e.asset, 64)), e.leaf);
    }

    let trees = SpendTrees::<P, 64> { state, nullifiers };
    let built = build_spend::<P, 64>(&trees, &SpendParams {
        secret: acc[0].0, salt: acc[0].1, sender_blinding: Fr::from(3u64), sender_old_balance: 10_000,
        recipient: Party { id: acc[1].2, blinding: Fr::from(4u64), old_balance: 50 },
        treasury: Party { id: treasury_id(), blinding: Fr::from(5u64), old_balance: 0 },
        asset, amount: 1_000, domain_id: 1,
    }, SpendLayout::V6).unwrap();
    assert!(spend_valid::<P, 64>(&built.circuit));
    let cs = ConstraintSystem::<Fr>::new_ref();
    built.circuit.clone().generate_constraints(cs.clone()).unwrap();
    assert!(cs.is_satisfied().unwrap(), "migrated v5 leaf is spendable under v6 at D64");
    println!("v6 D64 constraints: {}", cs.num_constraints());
    assert_eq!(cs.num_constraints(), crate::circuit_id::CIRCUIT_CONSTRAINTS_V6);
}

#[test]
fn tags_select_layout_and_unknown_tags_are_rejected() {
    use crate::circuit_id::*;
    assert_eq!(layout_for_tag(CIRCUIT_TAG_V6), Some((SpendLayout::V6, 64)));
    assert_eq!(layout_for_tag(LEGACY_CIRCUIT_TAG_V5), Some((SpendLayout::V5Legacy, 32)));
    assert_eq!(layout_for_tag("UEP-27-SPEND-POSEIDON-D32-v4-assetkey"), None);
    assert_ne!(CIRCUIT_TAG_V6, LEGACY_CIRCUIT_TAG_V5);
}

#[test]
fn v5_and_v6_systems_differ_so_proofs_do_not_cross() {
    // Same economic spend, both layouts: different constraint systems (different VKs), and a
    // v5 witness does not satisfy v6 (the sender leaf keeps the old blinding).
    let mut rng = StdRng::seed_from_u64(5);
    let v5 = random_honest::<4>(&mut rng, SpendLayout::V5Legacy);
    let mut as_v6 = v5.clone();
    as_v6.layout = SpendLayout::V6;
    as_v6.sender_new_blinding = rotate_blinding::<P>(v5.sender_secret, v5.note_nonce);
    assert!(sat(&v5));
    assert!(!sat(&as_v6), "a v5 witness is not a v6 witness");
    let n = |c: &SpendCircuit<4>| { let cs = ConstraintSystem::<Fr>::new_ref(); c.clone().generate_constraints(cs.clone()).unwrap(); cs.num_constraints() };
    assert_ne!(n(&v5), n(&as_v6));
}

#[test]
fn collision_bounds_documented() {
    let h32 = keys_at_half(32);
    let h64 = keys_at_half(64);
    assert!((77_000.0..77_300.0).contains(&h32), "{h32}");
    assert!((5.0e9..5.1e9).contains(&h64), "{h64}");
    // 10^6 keys: near-certain collision at D32, ~2.7e-8 at D64
    assert!(collision_probability(1e6, 32) > 0.99);
    assert!(collision_probability(1e6, 64) < 1e-7);
}
