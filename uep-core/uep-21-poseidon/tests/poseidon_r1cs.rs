use ark_bn254::{Bn254, Fr};
use ark_groth16::Groth16;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_snark::SNARK;
use ark_std::test_rng;

use uep21_poseidon_r1cs::{
    state_commitment, state_nullifier, uep_domain_hash, uep_poseidon_hash, DomainHashCircuit,
    PoseidonHashCircuit, D_LEAF,
};

#[test]
fn native_poseidon_is_deterministic_and_order_sensitive() {
    let a = Fr::from(123u64);
    let b = Fr::from(456u64);
    assert_eq!(uep_poseidon_hash(a, b), uep_poseidon_hash(a, b));
    assert_ne!(uep_poseidon_hash(a, b), uep_poseidon_hash(b, a));
    assert_ne!(uep_poseidon_hash(a, b), uep_poseidon_hash(a + Fr::from(1u64), b));
}

#[test]
fn r1cs_poseidon_matches_native() {
    let a = Fr::from(123u64);
    let b = Fr::from(456u64);
    let expected = uep_poseidon_hash(a, b);
    let circuit = PoseidonHashCircuit { a, b, expected };
    let cs = ConstraintSystem::<Fr>::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(cs.is_satisfied().unwrap());
    assert!(cs.num_constraints() > 0);
}

#[test]
fn wrong_digest_is_rejected() {
    let a = Fr::from(123u64);
    let b = Fr::from(456u64);
    let expected = uep_poseidon_hash(a, b) + Fr::from(1u64);
    let circuit = PoseidonHashCircuit { a, b, expected };
    let cs = ConstraintSystem::<Fr>::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(!cs.is_satisfied().unwrap());
}

#[test]
fn groth16_round_trip() {
    let mut rng = test_rng();
    let a = Fr::from(123u64);
    let b = Fr::from(456u64);
    let expected = uep_poseidon_hash(a, b);

    let setup_circuit = PoseidonHashCircuit { a, b, expected };
    let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(setup_circuit, &mut rng).unwrap();

    let prove_circuit = PoseidonHashCircuit { a, b, expected };
    let proof = Groth16::<Bn254>::prove(&pk, prove_circuit, &mut rng).unwrap();

    assert!(Groth16::<Bn254>::verify(&vk, &[expected], &proof).unwrap());
}

#[test]
fn domain_hash_r1cs_matches_native() {
    let a = Fr::from(1u64);
    let b = Fr::from(2u64);
    let expected = uep_domain_hash(D_LEAF, a, b);
    let circuit = DomainHashCircuit {
        domain: D_LEAF,
        a,
        b,
        expected,
    };
    let cs = ConstraintSystem::<Fr>::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(cs.is_satisfied().unwrap());
}

#[test]
fn domain_hash_wrong_digest_is_rejected() {
    let a = Fr::from(1u64);
    let b = Fr::from(2u64);
    let expected = uep_domain_hash(D_LEAF, a, b) + Fr::from(1u64);
    let circuit = DomainHashCircuit {
        domain: D_LEAF,
        a,
        b,
        expected,
    };
    let cs = ConstraintSystem::<Fr>::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    assert!(!cs.is_satisfied().unwrap());
}

#[test]
fn commitments_and_nullifiers_bind_inputs() {
    let c1 = state_commitment(Fr::from(100_000u64), Fr::from(111u64), Fr::from(222u64));
    let c2 = state_commitment(Fr::from(100_001u64), Fr::from(111u64), Fr::from(222u64));
    assert_ne!(c1, c2);

    let n1 = state_nullifier(Fr::from(123456u64), c1, Fr::from(10_000u64));
    let n2 = state_nullifier(Fr::from(123456u64), c1, Fr::from(10_001u64));
    assert_ne!(n1, n2);
}
