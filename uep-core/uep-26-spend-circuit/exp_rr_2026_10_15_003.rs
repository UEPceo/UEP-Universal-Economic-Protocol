//! Nightly bench (internal report UEP-RR-2026-10-15-003, experiments EXP-093/094/095), adapted
//! from Research's review-clone harness to circuit v6 (rotated sender blinding, empty receiving
//! slots). The .r1cs exporters (EXP-096/096b) are not carried over.
//!
//! Run: cargo test --release --lib exp_rr -- --ignored --nocapture   (≈4 min, 8 threads)
//! EXP093_N overrides the number of random worlds (default 300).
use std::collections::HashMap;
use ark_bn254::Fr;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem, ConstraintSystemRef, SynthesisError};
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::{fp::FpVar, FieldVar}};
use crate::hash_gadget::{h_account, h_nullifier, note_commitment, note_nonce, rotate_blinding, UepPoseidon};
use crate::spend_circuit::{SpendCircuit, SpendLayout};
use crate::smt_gadget::{low_bits_u64, state_index};
use crate::spend_v6::{build_spend, Party, SpendParams, SpendTrees};
use crate::expected_fee;

/// Small depth so that slot and nullifier collisions are exercised (16 slots).
const D: usize = 4;
type C = SpendCircuit<D>;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545F4914F6CDD1D) }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

fn key(a: Fr, s: Fr) -> (String, String) { (a.to_string(), s.to_string()) }

/// Native reference ledger (independent of the builder): balances + blindings per (account, asset).
#[derive(Clone)]
struct Ledger { leaves: HashMap<u64, Fr>, nf_set: HashMap<u64, Fr>, accts: HashMap<(String, String), (u64, Fr)>, slot_owner: HashMap<u64, (Fr, Fr)> }
impl Ledger {
    fn new() -> Self { Ledger { leaves: HashMap::new(), nf_set: HashMap::new(), accts: HashMap::new(), slot_owner: HashMap::new() } }
    fn open(&mut self, acct: Fr, asset: Fr, bal: u64, blind: Fr) -> bool {
        let idx = state_index::<UepPoseidon>(acct, asset, D);
        if let Some(o) = self.slot_owner.get(&idx) { if *o != (acct, asset) { return false; } }
        self.slot_owner.insert(idx, (acct, asset));
        self.accts.insert(key(acct, asset), (bal, blind));
        self.leaves.insert(idx, note_commitment::<UepPoseidon>(acct, asset, Fr::from(bal), blind));
        true
    }
    fn trees(&self) -> SpendTrees<UepPoseidon, D> {
        let mut t = SpendTrees::new();
        for (i, v) in &self.leaves { t.state.set(*i, *v); }
        for (i, v) in &self.nf_set { t.nullifiers.set(*i, *v); }
        t
    }
}

#[derive(Clone, Debug)]
struct Tx { secret: Fr, salt: Fr, recipient: Fr, treasury: Fr, asset: Fr, amount: u64, domain: u64 }

/// Blinding a receiver gets when its slot is opened by a payment (out-of-band, see R-BLIND).
fn open_blind(id: Fr) -> Fr { id + Fr::from(17u64) }

/// Intended semantics. v6: a receiver without a leaf is allowed (empty slot, balance 0).
fn intended_valid(l: &Ledger, tx: &Tx) -> Result<(), &'static str> {
    let sender = h_account::<UepPoseidon>(tx.secret, tx.salt);
    if tx.amount == 0 { return Err("amount=0"); }
    let fee = expected_fee(tx.amount);
    let (sb, _) = *l.accts.get(&key(sender, tx.asset)).ok_or("sender leaf missing")?;
    if sb < tx.amount.checked_add(fee).ok_or("overflow")? { return Err("insufficient"); }
    let rb = l.accts.get(&key(tx.recipient, tx.asset)).map(|x| x.0).unwrap_or(0);
    let tb = l.accts.get(&key(tx.treasury, tx.asset)).map(|x| x.0).unwrap_or(0);
    rb.checked_add(tx.amount).ok_or("recipient overflow")?;
    tb.checked_add(fee).ok_or("treasury overflow")?;
    if sender == tx.recipient || sender == tx.treasury || tx.recipient == tx.treasury { return Err("same party"); }
    Ok(())
}

fn sender_nf(l: &Ledger, tx: &Tx) -> (Fr, Fr) {
    let sender = h_account::<UepPoseidon>(tx.secret, tx.salt);
    let (sb, sbl) = l.accts[&key(sender, tx.asset)];
    let nonce = note_nonce::<UepPoseidon>(note_commitment::<UepPoseidon>(sender, tx.asset, Fr::from(sb), sbl), sbl);
    (h_nullifier::<UepPoseidon>(tx.secret, nonce), nonce)
}

/// Protocol predicate: intended + distinct slots + receiving slots free or owned + nullifier slot empty.
fn spend_valid(l: &Ledger, tx: &Tx) -> Result<(Fr, Fr), &'static str> {
    intended_valid(l, tx)?;
    let sender = h_account::<UepPoseidon>(tx.secret, tx.salt);
    let (si, ri, ti) = (state_index::<UepPoseidon>(sender, tx.asset, D), state_index::<UepPoseidon>(tx.recipient, tx.asset, D), state_index::<UepPoseidon>(tx.treasury, tx.asset, D));
    if si == ri || si == ti || ri == ti { return Err("party slot collision"); }
    for (id, i) in [(tx.recipient, ri), (tx.treasury, ti)] {
        if let Some(o) = l.slot_owner.get(&i) { if *o != (id, tx.asset) { return Err("receiving slot held by another account"); } }
    }
    let (nf, _) = sender_nf(l, tx);
    if let Some(prev) = l.nf_set.get(&low_bits_u64(nf, D)) {
        return Err(if *prev == nf { "nullifier already spent (same nf)" } else { "nullifier slot collision (other nf)" });
    }
    let mut l2 = l.clone();
    apply(&mut l2, tx);
    let t = l2.trees();
    Ok((t.state.root(), t.nullifiers.root()))
}

/// v6 transition: the sender moves to H(D_BLIND, secret, nonce).
fn apply(l: &mut Ledger, tx: &Tx) {
    let sender = h_account::<UepPoseidon>(tx.secret, tx.salt);
    let fee = expected_fee(tx.amount);
    let (sb, _) = l.accts[&key(sender, tx.asset)];
    let (nf, nonce) = sender_nf(l, tx);
    let (rb, rbl) = l.accts.get(&key(tx.recipient, tx.asset)).copied().unwrap_or((0, open_blind(tx.recipient)));
    let (tb, tbl) = l.accts.get(&key(tx.treasury, tx.asset)).copied().unwrap_or((0, open_blind(tx.treasury)));
    l.open(sender, tx.asset, sb - tx.amount - fee, rotate_blinding::<UepPoseidon>(tx.secret, nonce));
    l.open(tx.recipient, tx.asset, rb + tx.amount, rbl);
    l.open(tx.treasury, tx.asset, tb + fee, tbl);
    l.nf_set.insert(low_bits_u64(nf, D), nf);
}

fn build(l: &Ledger, tx: &Tx) -> Option<C> {
    let sender = h_account::<UepPoseidon>(tx.secret, tx.salt);
    let (sb, sbl) = *l.accts.get(&key(sender, tx.asset))?;
    let party = |id: Fr| {
        let (b, bl) = l.accts.get(&key(id, tx.asset)).copied().unwrap_or((0, open_blind(id)));
        Party { id, blinding: bl, old_balance: b }
    };
    let p = SpendParams { secret: tx.secret, salt: tx.salt, sender_blinding: sbl, sender_old_balance: sb, recipient: party(tx.recipient), treasury: party(tx.treasury), asset: tx.asset, amount: tx.amount, domain_id: tx.domain };
    build_spend::<UepPoseidon, D>(&l.trees(), &p, SpendLayout::V6).ok().map(|b| b.circuit)
}

fn sat(c: C) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    match c.generate_constraints(cs.clone()) { Ok(()) => cs.is_satisfied().unwrap_or(false), Err(_) => false }
}

fn mutants(c: &C) -> Vec<(String, C)> {
    let one = Fr::from(1u64);
    let mut v = vec![];
    macro_rules! fr { ($($f:ident),*) => { $( { let mut m = c.clone(); m.$f += one; v.push((stringify!($f).to_string(), m)); } )* } }
    fr!(old_state_root, new_state_root, old_nullifier_root, new_nullifier_root, sender_id, recipient_id, treasury_id, asset_id, amount, fee, nullifier, transaction_commitment, domain_id,
        sender_secret, sender_salt, note_blinding, note_nonce, sender_new_blinding, sender_old_amount, sender_new_amount, recipient_old_amount, recipient_new_amount, treasury_old_amount, treasury_new_amount,
        mid_root_after_sender, mid_root_after_recipient, sender_old_leaf, sender_new_leaf, recipient_old_leaf, recipient_new_leaf, recipient_blinding, treasury_old_leaf, treasury_new_leaf, treasury_blinding, nullifier_leaf);
    macro_rules! idx { ($($f:ident),*) => { $( { let mut m = c.clone(); m.$f ^= 1; v.push((stringify!($f).to_string(), m)); } )* } }
    idx!(sender_index, recipient_index, treasury_index, nullifier_index);
    macro_rules! arrs { ($($f:ident),*) => { $( for i in 0..D { let mut m = c.clone(); m.$f[i] += one; v.push((format!("{}[{}]", stringify!($f), i), m)); } )* } }
    arrs!(sender_siblings, recipient_siblings, treasury_siblings, nullifier_siblings);
    macro_rules! bits { ($($f:ident),*) => { $( for i in 0..D { let mut m = c.clone(); m.$f[i] = !m.$f[i]; v.push((format!("{}[{}]", stringify!($f), i), m)); } )* } }
    bits!(sender_index_bits, recipient_index_bits, treasury_index_bits, nullifier_index_bits);
    { let mut m = c.clone(); m.recipient_slot_empty = !m.recipient_slot_empty; v.push(("recipient_slot_empty".into(), m)); }
    { let mut m = c.clone(); m.treasury_slot_empty = !m.treasury_slot_empty; v.push(("treasury_slot_empty".into(), m)); }
    v
}

fn random_world(rng: &mut Rng) -> (Ledger, Tx) {
    loop {
        let mut l = Ledger::new();
        let asset = Fr::from(1 + rng.below(3));
        let (secret, salt) = (Fr::from(rng.next()), Fr::from(rng.next()));
        let sender = h_account::<UepPoseidon>(secret, salt);
        let recipient = Fr::from(rng.next());
        let treasury = Fr::from(44u64);
        let amount = 1 + rng.below(50_000);
        let bal = amount + expected_fee(amount) + rng.below(100_000);
        if !l.open(sender, asset, bal, Fr::from(rng.next())) { continue; }
        // v6: receivers may have no leaf yet (empty slot)
        if rng.below(4) != 0 && !l.open(recipient, asset, rng.below(1_000_000), Fr::from(rng.next())) { continue; }
        if rng.below(4) != 0 && !l.open(treasury, asset, rng.below(1_000_000), Fr::from(rng.next())) { continue; }
        for _ in 0..rng.below(6) { let _ = l.open(Fr::from(rng.next()), asset, rng.below(1000), Fr::from(rng.next())); }
        for _ in 0..rng.below(5) { let nf = Fr::from(rng.next()); let i = low_bits_u64(nf, D); l.nf_set.entry(i).or_insert(nf); }
        return (l, Tx { secret, salt, recipient, treasury, asset, amount, domain: 1 });
    }
}

fn par<T: Send + 'static, F: Fn(usize) -> T + Send + Sync + 'static>(n: usize, threads: usize, f: F) -> Vec<T> {
    let f = std::sync::Arc::new(f);
    let hs: Vec<_> = (0..threads).map(|t| { let f = f.clone(); std::thread::spawn(move || (t..n).step_by(threads).map(|i| (i, f(i))).collect::<Vec<_>>()) }).collect();
    let mut out: Vec<(usize, T)> = hs.into_iter().flat_map(|h| h.join().unwrap()).collect();
    out.sort_by_key(|x| x.0);
    out.into_iter().map(|x| x.1).collect()
}

/// EXP-093: circuit vs ledger-level spend_valid, both directions, plus single-field mutants.
#[test]
#[ignore]
fn exp093_differential_v6() {
    let n = std::env::var("EXP093_N").ok().and_then(|s| s.parse().ok()).unwrap_or(300usize);
    let res = par(n, 8, |i| {
        let mut rng = Rng(0x9E3779B97F4A7C15 ^ (i as u64 + 1).wrapping_mul(0x1000193));
        let (l, tx) = random_world(&mut rng);
        let spec = spend_valid(&l, &tx);
        let built = build(&l, &tx);
        let circ = built.clone().map(sat).unwrap_or(false);
        let roots_ok = match (&spec, &built) { (Ok((s, nf)), Some(c)) => c.new_state_root == *s && c.new_nullifier_root == *nf, _ => true };
        (spec.map(|_| ()).map_err(|e| e.to_string()), circ, roots_ok)
    });
    let (mut sound_bad, mut compl_bad, mut roots_bad) = (0, 0, 0);
    let mut tab: HashMap<String, usize> = HashMap::new();
    for (spec, circ, roots_ok) in &res {
        *tab.entry(format!("spec={} circuit={circ}", match spec { Ok(_) => "OK".into(), Err(e) => e.clone() })).or_default() += 1;
        if *circ && spec.is_err() { sound_bad += 1 }
        if !*circ && spec.is_ok() { compl_bad += 1 }
        if !roots_ok { roots_bad += 1 }
    }
    let mut ks: Vec<_> = tab.into_iter().collect();
    ks.sort();
    for (k, c) in ks { println!("EXP093 {c:5} {k}"); }
    println!("EXP093 n={n} circuit-accepts-spec-rejects={sound_bad} spec-accepts-circuit-rejects={compl_bad} root-mismatch={roots_bad}");
    assert_eq!((sound_bad, compl_bad, roots_bad), (0, 0, 0));

    let worlds: Vec<(Ledger, Tx)> = (0..400u64).map(|i| { let mut r = Rng(0xABCDEF ^ (i + 7).wrapping_mul(0x1000193)); random_world(&mut r) }).filter(|(l, t)| spend_valid(l, t).is_ok()).take(24).collect();
    let mut jobs: Vec<(String, C)> = vec![];
    for (l, t) in &worlds { jobs.extend(mutants(&build(l, t).unwrap())); }
    let njobs = jobs.len();
    let jobs = std::sync::Arc::new(jobs);
    let j2 = jobs.clone();
    let out = par(njobs, 8, move |i| sat(j2[i].1.clone()));
    let surv: Vec<_> = out.iter().enumerate().filter(|(_, s)| **s).map(|(i, _)| jobs[i].0.clone()).collect();
    println!("EXP093 mutation: worlds={} mutants={njobs} satisfied-mutants={} {:?}", worlds.len(), surv.len(), surv);
    assert!(surv.is_empty(), "single-field mutants accepted: {surv:?}");
}

/// EXP-095 (F1 end to end): A(10 000) → B 1 000; B → A 1 001; A spends again from 10 000.
#[test]
#[ignore]
fn exp095_f1_end_to_end_v6() {
    let mut l = Ledger::new();
    let asset = Fr::from(1u64);
    let (sa, sla) = (Fr::from(42u64), Fr::from(7u64));
    let a = h_account::<UepPoseidon>(sa, sla);
    let t = Fr::from(44u64);
    let si = |x: Fr| state_index::<UepPoseidon>(x, asset, D);
    let mut k = 1001u64;
    while { let b = h_account::<UepPoseidon>(Fr::from(k), Fr::from(9u64)); si(b) == si(a) || si(b) == si(t) || si(a) == si(t) } { k += 1; }
    let (sb, slb) = (Fr::from(k), Fr::from(9u64));
    let b = h_account::<UepPoseidon>(sb, slb);
    assert!(l.open(a, asset, 10_000, Fr::from(3u64)) && l.open(b, asset, 5_000, Fr::from(4u64)) && l.open(t, asset, 0, Fr::from(5u64)));
    let tx1 = Tx { secret: sa, salt: sla, recipient: b, treasury: t, asset, amount: 1_000, domain: 1 };
    assert!(spend_valid(&l, &tx1).is_ok() && sat(build(&l, &tx1).unwrap()));
    let nf1 = build(&l, &tx1).unwrap().nullifier;
    apply(&mut l, &tx1);
    let tx2 = Tx { secret: sb, salt: slb, recipient: a, treasury: t, asset, amount: 1_000 + expected_fee(1_000), domain: 1 };
    assert!(spend_valid(&l, &tx2).is_ok() && sat(build(&l, &tx2).unwrap()));
    apply(&mut l, &tx2);
    assert_eq!(l.accts[&key(a, asset)].0, 10_000);
    for amt in [500u64, 1, 10, 9_000] {
        let tx3 = Tx { secret: sa, salt: sla, recipient: b, treasury: t, asset, amount: amt, domain: 1 };
        let c3 = build(&l, &tx3).expect("v6 builds");
        println!("EXP095 A(10000 again) amount={amt}: nf==nf1 {} spec={:?} circuit={}", c3.nullifier == nf1, spend_valid(&l, &tx3).map(|_| "OK"), sat(c3.clone()));
        // At D=4 the fresh nullifier can still land on an occupied slot (F2 at toy depth);
        // the property under test is that it is a different nullifier.
        assert_ne!(c3.nullifier, nf1, "F1: v6 must not repeat the nullifier");
        assert_eq!(spend_valid(&l, &tx3).is_ok(), sat(c3));
    }
}

#[derive(Clone)]
struct WithFree(C);
impl ConstraintSynthesizer<Fr> for WithFree {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        self.0.generate_constraints(cs.clone())?;
        let x = FpVar::new_witness(cs, || Ok(Fr::from(5u64)))?;
        (x * FpVar::zero()).enforce_equal(&FpVar::zero())
    }
}

fn perturb<S: ConstraintSynthesizer<Fr> + Clone + Send + 'static>(label: &'static str, mk: fn() -> S, threads: usize) -> (Vec<usize>, Vec<usize>, usize) {
    let cs = ConstraintSystem::<Fr>::new_ref();
    mk().generate_constraints(cs.clone()).unwrap();
    cs.finalize();
    assert!(cs.is_satisfied().unwrap());
    let (nw, ni, nc) = (cs.num_witness_variables(), cs.num_instance_variables(), cs.num_constraints());
    let t0 = std::time::Instant::now();
    let res = par(threads, threads, move |t| {
        let cs = ConstraintSystem::<Fr>::new_ref();
        mk().generate_constraints(cs.clone()).unwrap();
        cs.finalize();
        let (mut sw, mut si) = (vec![], vec![]);
        for i in (t..nw).step_by(threads) {
            let o = cs.borrow().unwrap().witness_assignment[i];
            cs.borrow_mut().unwrap().witness_assignment[i] = o + Fr::from(1u64);
            if cs.is_satisfied().unwrap() { sw.push(i) }
            cs.borrow_mut().unwrap().witness_assignment[i] = o;
        }
        for i in (1 + t..ni).step_by(threads) {
            let o = cs.borrow().unwrap().instance_assignment[i];
            cs.borrow_mut().unwrap().instance_assignment[i] = o + Fr::from(1u64);
            if cs.is_satisfied().unwrap() { si.push(i) }
            cs.borrow_mut().unwrap().instance_assignment[i] = o;
        }
        (sw, si)
    });
    let sw: Vec<usize> = res.iter().flat_map(|r| r.0.clone()).collect();
    let si: Vec<usize> = res.iter().flat_map(|r| r.1.clone()).collect();
    println!("EXP094 {label}: constraints={nc} witness={nw} instance={ni} surviving_witness={sw:?} surviving_public={si:?} secs={}", t0.elapsed().as_secs());
    (sw, si, nw)
}

fn mk_v6() -> C {
    let mut rng = Rng(2026);
    loop {
        let (l, tx) = random_world(&mut rng);
        if spend_valid(&l, &tx).is_ok() { return build(&l, &tx).unwrap(); }
    }
}
fn mk_ctrl() -> WithFree { WithFree(mk_v6()) }

/// EXP-094: perturbation probe (finalized CS, every witness and public input) + positive control.
#[test]
#[ignore]
fn exp094_perturbation_v6_poseidon_d4() {
    let (sw, _, nw) = perturb("v6-D4+control", mk_ctrl, 8);
    assert_eq!(sw, vec![nw - 1], "control: the planted free witness must be found");
    let (sw, si, _) = perturb("v6-D4", mk_v6, 8);
    assert!(sw.is_empty() && si.is_empty(), "free variables in v6: {sw:?} {si:?}");
}

