//! UEP-22 final circuit architecture.
//!
//! The important property is that Poseidon is evaluated INSIDE R1CS.
//! No native digest is injected as a circuit constant.
//!
//! Reference pattern follows the published Arkworks/Webb PoseidonCircuit:
//! witness a,b; public c; PoseidonGadget::hash([a,b]); enforce equality.

use ark_bn254::Fr;
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use arkworks_native_gadgets::poseidon::{
    sbox::PoseidonSbox, FieldHasher, Poseidon, PoseidonParameters,
};
use arkworks_r1cs_gadgets::poseidon::{FieldHasherGadget, PoseidonGadget};
use arkworks_utils::{
    bytes_matrix_to_f, bytes_vec_to_f, poseidon_params::setup_poseidon_params, Curve,
};

pub fn setup_bn254_poseidon_params() -> PoseidonParameters<Fr> {
    // Width 3 = Poseidon(t=3), i.e. two field inputs + one capacity element.
    // alpha=5 is the Circom-compatible BN254 construction used by the
    // light-poseidon/circom ecosystem.
    //
    // The exact parameter source is Arkworks' bundled parameter generator.
    let pos_data = setup_poseidon_params(Curve::Bn254, 5, 3).unwrap();

    PoseidonParameters {
        mds_matrix: bytes_matrix_to_f(&pos_data.mds),
        round_keys: bytes_vec_to_f(&pos_data.rounds),
        full_rounds: pos_data.full_rounds,
        partial_rounds: pos_data.partial_rounds,
        sbox: PoseidonSbox(pos_data.exp),
        width: pos_data.width,
    }
}

#[derive(Clone)]
pub struct Poseidon2To1Circuit {
    pub a: Fr,
    pub b: Fr,
    pub expected: Fr,
    pub hasher: Poseidon<Fr>,
}

impl ConstraintSynthesizer<Fr> for Poseidon2To1Circuit {
    fn generate_constraints(
        self,
        cs: ConstraintSystemRef<Fr>,
    ) -> Result<(), SynthesisError> {
        let a = FpVar::<Fr>::new_witness(cs.clone(), || Ok(self.a))?;
        let b = FpVar::<Fr>::new_witness(cs.clone(), || Ok(self.b))?;
        let expected = FpVar::<Fr>::new_input(cs.clone(), || Ok(self.expected))?;

        let gadget: PoseidonGadget<Fr> =
            FieldHasherGadget::<Fr>::from_native(&mut cs.clone(), self.hasher)?;

        let digest = gadget.hash(&[a, b])?;
        digest.enforce_equal(&expected)?;
        Ok(())
    }
}

/// Full UEP-22 fee statement:
///
/// fee * 10_000 = amount * 10
///
/// and:
///
/// TreasuryCommitment = Poseidon(TreasuryID, fee)
#[derive(Clone)]
pub struct TreasuryFeeCircuit {
    pub treasury_id: Fr,
    pub amount: Fr,
    pub expected_commitment: Fr,
    pub fee: Option<Fr>,
    pub hasher: Poseidon<Fr>,
}

impl ConstraintSynthesizer<Fr> for TreasuryFeeCircuit {
    fn generate_constraints(
        self,
        cs: ConstraintSystemRef<Fr>,
    ) -> Result<(), SynthesisError> {
        let treasury = FpVar::<Fr>::new_witness(cs.clone(), || Ok(self.treasury_id))?;
        let amount = FpVar::<Fr>::new_witness(cs.clone(), || Ok(self.amount))?;
        let expected = FpVar::<Fr>::new_input(
            cs.clone(),
            || Ok(self.expected_commitment),
        )?;

        let fee = FpVar::<Fr>::new_witness(
            cs.clone(),
            || self.fee.ok_or(SynthesisError::AssignmentMissing),
        )?;

        // Exact fee relation: fee * 10_000 = amount * 10.
        let lhs = &fee * Fr::from(10_000u64);
        let rhs = &amount * Fr::from(10u64);
        lhs.enforce_equal(&rhs)?;

        // CRITICAL: Poseidon is now a genuine R1CS gadget.
        let gadget: PoseidonGadget<Fr> =
            FieldHasherGadget::<Fr>::from_native(&mut cs.clone(), self.hasher)?;
        let digest = gadget.hash(&[treasury, fee])?;
        digest.enforce_equal(&expected)?;

        Ok(())
    }
}
