//! v0.5.3: StateTransitionCircuit compiles and is exercised (one-leaf transfer, 0.1% fee).
use ark_bn254::Fr;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use arkworks_native_gadgets::poseidon::{FieldHasher, Poseidon};
use uep_22_final_poseidon_r1cs::circuit::setup_bn254_poseidon_params;
use uep_22_final_poseidon_r1cs::state_transition::{StateTransitionCircuit, TREE_DEPTH, UEP_TREASURY_DOMAIN};

fn h() -> Poseidon<Fr> { Poseidon::new(setup_bn254_poseidon_params()) }

fn root(leaf: Fr, sib: &[Fr], dir: &[bool]) -> Fr {
    let p = h();
    let mut cur = leaf;
    for (s, d) in sib.iter().zip(dir) {
        cur = if *d { p.hash(&[*s, cur]).unwrap() } else { p.hash(&[cur, *s]).unwrap() };
    }
    cur
}

fn circuit(amount: u64, fee: u64, remainder: u64) -> StateTransitionCircuit {
    let p = h();
    let account = Fr::from(77u64);
    let old_balance = 1_000_000u64;
    let new_balance = old_balance - amount - fee;
    let siblings: Vec<Fr> = (0..TREE_DEPTH as u64).map(|i| Fr::from(i * 3 + 1)).collect();
    let directions: Vec<bool> = (0..TREE_DEPTH).map(|i| i % 3 == 0).collect();
    let old_root = root(p.hash(&[account, Fr::from(old_balance)]).unwrap(), &siblings, &directions);
    let new_root = root(p.hash(&[account, Fr::from(new_balance)]).unwrap(), &siblings, &directions);
    let (secret, nonce) = (Fr::from(11u64), Fr::from(12u64));
    StateTransitionCircuit {
        old_root, new_root,
        nullifier: p.hash(&[secret, nonce]).unwrap(),
        treasury_commitment: p.hash(&[Fr::from(UEP_TREASURY_DOMAIN), Fr::from(fee)]).unwrap(),
        account_id: account, old_balance, new_balance, amount, fee, remainder,
        secret, nonce, siblings, directions, hasher: h(),
    }
}

fn satisfied(c: StateTransitionCircuit) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    c.generate_constraints(cs.clone()).unwrap();
    cs.is_satisfied().unwrap()
}

#[test]
fn valid_transition_with_floor_fee_is_satisfied() {
    assert!(satisfied(circuit(12_345, 12, 345)));
}

#[test]
fn wrong_fee_or_out_of_range_remainder_is_rejected() {
    assert!(!satisfied(circuit(12_345, 11, 1_345)));
    let mut c = circuit(12_345, 12, 345);
    c.nullifier += Fr::from(1u64);
    assert!(!satisfied(c));
}
