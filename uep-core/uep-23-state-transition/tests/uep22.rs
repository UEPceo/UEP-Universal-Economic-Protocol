use ark_bn254::{Bn254, Fr};
use ark_crypto_primitives::snark::SNARK;
use ark_relations::r1cs::ConstraintSynthesizer;
use arkworks_native_gadgets::poseidon::FieldHasher;
use ark_groth16::Groth16;
use ark_relations::r1cs::ConstraintSystem;
use ark_std::test_rng;

use uep_22_final_poseidon_r1cs::circuit::{
    setup_bn254_poseidon_params, Poseidon2To1Circuit, TreasuryFeeCircuit,
};

fn hasher() -> arkworks_native_gadgets::poseidon::Poseidon<Fr> {
    arkworks_native_gadgets::poseidon::Poseidon::new(
        setup_bn254_poseidon_params()
    )
}

#[test]
fn r1cs_poseidon_matches_native_digest() {
    let a = Fr::from(1u64);
    let b = Fr::from(2u64);

    let native = hasher();
    let expected = native.hash(&[a, b]).unwrap();

    let cs = ConstraintSystem::<Fr>::new_ref();
    Poseidon2To1Circuit {
        a,
        b,
        expected,
        hasher: hasher(),
    }
    .generate_constraints(cs.clone())
    .unwrap();

    assert!(cs.is_satisfied().unwrap());
    assert!(cs.num_constraints() > 0);
}

#[test]
fn wrong_digest_fails_r1cs() {
    let a = Fr::from(1u64);
    let b = Fr::from(2u64);

    let native = hasher();
    let correct = native.hash(&[a, b]).unwrap();
    let wrong = correct + Fr::from(1u64);

    let cs = ConstraintSystem::<Fr>::new_ref();
    Poseidon2To1Circuit {
        a,
        b,
        expected: wrong,
        hasher: hasher(),
    }
    .generate_constraints(cs.clone())
    .unwrap();

    assert!(!cs.is_satisfied().unwrap());
}

#[test]
fn treasury_fee_is_01_percent_and_wrong_fee_fails() {
    let treasury = Fr::from(123456u64);
    let amount = Fr::from(100_000u64);
    let fee = Fr::from(100u64);

    let native = hasher();
    let commitment = native.hash(&[treasury, fee]).unwrap();

    let cs = ConstraintSystem::<Fr>::new_ref();
    TreasuryFeeCircuit {
        treasury_id: treasury,
        amount,
        expected_commitment: commitment,
        fee: Some(fee),
        hasher: hasher(),
    }
    .generate_constraints(cs.clone())
    .unwrap();

    assert!(cs.is_satisfied().unwrap());

    let bad_cs = ConstraintSystem::<Fr>::new_ref();
    TreasuryFeeCircuit {
        treasury_id: treasury,
        amount,
        expected_commitment: commitment,
        fee: Some(99u64.into()),
        hasher: hasher(),
    }
    .generate_constraints(bad_cs.clone())
    .unwrap();

    assert!(!bad_cs.is_satisfied().unwrap());
}

#[test]
fn groth16_rejects_tampered_amount() {
    let mut rng = test_rng();
    let treasury = Fr::from(123456u64);
    let amount = Fr::from(100_000u64);
    let fee = Fr::from(100u64);

    let native = hasher();
    let commitment = native.hash(&[treasury, fee]).unwrap();

    let setup = TreasuryFeeCircuit {
        treasury_id: treasury,
        amount,
        expected_commitment: commitment,
        fee: None,
        hasher: hasher(),
    };

    let (pk, vk) =
        Groth16::<Bn254>::circuit_specific_setup(setup, &mut rng).unwrap();

    let prove = TreasuryFeeCircuit {
        treasury_id: treasury,
        amount,
        expected_commitment: commitment,
        fee: Some(fee),
        hasher: hasher(),
    };

    let proof = Groth16::<Bn254>::prove(&pk, prove, &mut rng).unwrap();

    // In this circuit only expected_commitment is public; treasury/amount are
    // witnesses. The proof therefore proves the fee relation and commitment.
    let public_inputs = [commitment];
    assert!(Groth16::<Bn254>::verify(&vk, &public_inputs, &proof).unwrap());

    // Tampering the public commitment invalidates the proof.
    let tampered = [commitment + Fr::from(1u64)];
    assert!(!Groth16::<Bn254>::verify(&vk, &tampered, &proof).unwrap());
}
