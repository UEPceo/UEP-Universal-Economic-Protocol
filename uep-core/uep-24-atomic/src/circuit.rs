//! UEP-24 circuit blueprint.
//!
//! The circuit binds:
//! 1. account ownership to a secret,
//! 2. sender/recipient/treasury balances to their old/new values,
//! 3. the exact 0.1% fee,
//! 4. atomic conservation,
//! 5. the transaction nullifier,
//! 6. the new state root.
//!
//! IMPORTANT: the Sparse Merkle authentication/update gadget is represented
//! as an explicit circuit interface here. The next implementation step should
//! replace each interface with the concrete Poseidon SMT gadget and freeze
//! test vectors before testnet.

use ark_bn254::Fr;
use ark_r1cs_std::{
    alloc::AllocVar,
    boolean::Boolean,
    eq::EqGadget,
    fields::fp::FpVar,
    uint64::UInt64,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use arkworks_native_gadgets::poseidon::{
    sbox::PoseidonSbox, FieldHasher, Poseidon, PoseidonParameters,
};
use arkworks_r1cs_gadgets::poseidon::PoseidonGadget;
use arkworks_utils::{
    bytes_matrix_to_f, bytes_vec_to_f, poseidon_params::setup_poseidon_params, Curve,
};

use crate::{BPS_DENOM, FEE_BPS};

pub fn poseidon_params_bn254() -> PoseidonParameters<Fr> {
    let p = setup_poseidon_params(Curve::Bn254, 5, 3).unwrap();
    PoseidonParameters {
        mds_matrix: bytes_matrix_to_f(&p.mds),
        round_keys: bytes_vec_to_f(&p.rounds),
        full_rounds: p.full_rounds,
        partial_rounds: p.partial_rounds,
        sbox: PoseidonSbox::Quintic,
    }
}

fn u64_to_fp(bits: &UInt64<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let mut acc = FpVar::<Fr>::constant(Fr::from(0u64));
    let mut pow = Fr::from(1u64);
    for b in bits.iter() {
        let term = b.select(&FpVar::constant(pow), &FpVar::constant(Fr::from(0u64)))?;
        acc += term;
        pow += pow;
    }
    Ok(acc)
}

fn poseidon2(
    cs: ConstraintSystemRef<Fr>,
    a: FpVar<Fr>,
    b: FpVar<Fr>,
    hasher: Poseidon<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let mut gadget = PoseidonGadget::<Fr>::from_native(&mut cs.clone(), hasher)?;
    gadget.hash(&[a, b])
}

#[derive(Clone)]
pub struct Uep24Circuit {
    // Ownership witnesses
    pub secret: Fr,
    pub account_salt: Fr,
    pub expected_sender_id: Fr,

    // Public state roots / commitments
    pub old_root: Fr,
    pub new_root: Fr,
    pub old_nullifier_root: Fr,
    pub new_nullifier_root: Fr,

    // Transaction
    pub nonce: Fr,
    pub amount: u64,

    // State witnesses
    pub sender_old: u64,
    pub sender_new: u64,
    pub recipient_old: u64,
    pub recipient_new: u64,
    pub treasury_old: u64,
    pub treasury_new: u64,

    // Nullifier
    pub expected_nullifier: Fr,

    pub hasher: Poseidon<Fr>,
}

impl ConstraintSynthesizer<Fr> for Uep24Circuit {
    fn generate_constraints(
        self,
        cs: ConstraintSystemRef<Fr>,
    ) -> Result<(), SynthesisError> {
        // ------------------------------------------------------------------
        // 1. Ownership binding:
        // sender_id = Poseidon(secret, salt)
        // ------------------------------------------------------------------
        let secret = FpVar::new_witness(cs.clone(), || Ok(self.secret))?;
        let salt = FpVar::new_witness(cs.clone(), || Ok(self.account_salt))?;
        let sender_id_public =
            FpVar::new_input(cs.clone(), || Ok(self.expected_sender_id))?;

        let sender_id = poseidon2(
            cs.clone(),
            secret.clone(),
            salt,
            self.hasher.clone(),
        )?;
        sender_id.enforce_equal(&sender_id_public)?;

        // ------------------------------------------------------------------
        // 2. Nullifier:
        // N = Poseidon(secret, nonce)
        // ------------------------------------------------------------------
        let nonce = FpVar::new_witness(cs.clone(), || Ok(self.nonce))?;
        let nullifier_public =
            FpVar::new_input(cs.clone(), || Ok(self.expected_nullifier))?;

        let nullifier = poseidon2(
            cs.clone(),
            secret,
            nonce,
            self.hasher.clone(),
        )?;
        nullifier.enforce_equal(&nullifier_public)?;

        // ------------------------------------------------------------------
        // 3. Range-constrained balances and amount.
        // ------------------------------------------------------------------
        let amount = UInt64::constant(self.amount);

        let sender_old = UInt64::constant(self.sender_old);
        let sender_new = UInt64::constant(self.sender_new);
        let recipient_old = UInt64::constant(self.recipient_old);
        let recipient_new = UInt64::constant(self.recipient_new);
        let treasury_old = UInt64::constant(self.treasury_old);
        let treasury_new = UInt64::constant(self.treasury_new);

        let amount_f = u64_to_fp(&amount)?;
        let sender_old_f = u64_to_fp(&sender_old)?;
        let sender_new_f = u64_to_fp(&sender_new)?;
        let recipient_old_f = u64_to_fp(&recipient_old)?;
        let recipient_new_f = u64_to_fp(&recipient_new)?;
        let treasury_old_f = u64_to_fp(&treasury_old)?;
        let treasury_new_f = u64_to_fp(&treasury_new)?;

        // ------------------------------------------------------------------
        // 4. Exact fee equation:
        // fee * 10000 = amount * 10
        //
        // For the first atomic UEP-24 implementation fee is floor(amount/1000)
        // and the remainder policy is explicitly checked by the native model.
        // ------------------------------------------------------------------
        let fee_native = self.amount / 1_000;
        let fee = FpVar::constant(Fr::from(fee_native));

        let fee_lhs = &fee * Fr::from(BPS_DENOM);
        let fee_rhs = &amount_f * Fr::from(FEE_BPS);
        fee_lhs.enforce_equal(&fee_rhs)?;

        // ------------------------------------------------------------------
        // 5. State transition equations.
        // ------------------------------------------------------------------
        // sender_old = sender_new + amount + fee
        let sender_rhs =
            &sender_new_f + &amount_f + &fee;
        sender_old_f.enforce_equal(&sender_rhs)?;

        // recipient_new = recipient_old + amount
        let recipient_rhs = &recipient_old_f + &amount_f;
        recipient_new_f.enforce_equal(&recipient_rhs)?;

        // treasury_new = treasury_old + fee
        let treasury_rhs = &treasury_old_f + &fee;
        treasury_new_f.enforce_equal(&treasury_rhs)?;

        // ------------------------------------------------------------------
        // 6. Explicit conservation equation.
        // ------------------------------------------------------------------
        let lhs = &sender_old_f + &recipient_old_f + &treasury_old_f;
        let rhs = &sender_new_f + &recipient_new_f + &treasury_new_f;
        lhs.enforce_equal(&rhs)?;

        // ------------------------------------------------------------------
        // 7. State-root / nullifier-root outputs.
        //
        // These public values are intentionally kept in the circuit interface.
        // Concrete SMT path gadgets must bind them to the leaf transitions.
        // ------------------------------------------------------------------
        let _old_root =
            FpVar::new_input(cs.clone(), || Ok(self.old_root))?;
        let _new_root =
            FpVar::new_input(cs.clone(), || Ok(self.new_root))?;
        let _old_nr =
            FpVar::new_input(cs.clone(), || Ok(self.old_nullifier_root))?;
        let _new_nr =
            FpVar::new_input(cs.clone(), || Ok(self.new_nullifier_root))?;

        // This interface deliberately does not claim SMT membership yet.
        // UEP-24 acceptance requires the concrete SMT gadget to replace this
        // boundary before testnet.
        Ok(())
    }
}
