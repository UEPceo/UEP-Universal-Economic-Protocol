// UEP-26 circuit scaffold.
//
// Arithmetic/range boundary + domain-hash composition (`hash_gadget`) +
// SMT direction/membership/update (`smt_gadget`).
// Full multi-account SpendCircuit is in `spend_circuit`.

pub mod hash_gadget;
pub mod smt_gadget;
pub mod spend_circuit;
pub mod circuit_id;
pub mod native_smt;
pub mod poseidon_suite;
pub mod groth16_spend;
pub mod prove_request;
pub mod canonical_state;
pub mod network_profile;

use ark_bn254::Fr;
use ark_r1cs_std::{
    alloc::AllocVar,
    eq::EqGadget,
    fields::{fp::FpVar, FieldVar},
    R1CSVar, ToBitsGadget,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

#[derive(Clone)]
pub struct SpendArithmeticCircuit {
    pub amount: Fr,
    pub fee: Fr,
    pub sender_old: Fr,
    pub sender_new: Fr,
    pub recipient_old: Fr,
    pub recipient_new: Fr,
    pub treasury_old: Fr,
    pub treasury_new: Fr,
}

/// Fee policy: fee = floor(amount * 10 / 10_000)  (0.1%).
pub fn expected_fee(amount: u64) -> u64 {
    amount.saturating_mul(10) / 10_000
}

pub fn enforce_u64(cs: ConstraintSystemRef<Fr>, x: &FpVar<Fr>) -> Result<(), SynthesisError> {
    // Bit decomposition is required for range safety. Reconstruct the low 64
    // bits and force all higher bits to zero (no modular wraparound witness).
    let bits = x.to_bits_le()?;
    let mut acc = FpVar::<Fr>::zero();
    let mut coeff = Fr::from(1u64);
    for bit in bits.iter().take(64) {
        acc += FpVar::from(bit.clone()) * coeff;
        coeff += coeff;
        let _ = &cs;
    }
    acc.enforce_equal(x)?;
    for bit in bits.iter().skip(64) {
        bit.enforce_equal(&ark_r1cs_std::boolean::Boolean::constant(false))?;
    }
    Ok(())
}

pub fn enforce_fee_policy(
    cs: ConstraintSystemRef<Fr>,
    amount: &FpVar<Fr>,
    fee: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    // fee * 10000 + r = amount * 10, with 0 <= r <= 9999.
    let r = FpVar::new_witness(cs.clone(), || {
        let a = amount.value().unwrap_or(Fr::from(0u64));
        let f = fee.value().unwrap_or(Fr::from(0u64));
        Ok(a * Fr::from(10u64) - f * Fr::from(10_000u64))
    })?;
    (fee * Fr::from(10_000u64) + &r).enforce_equal(&(amount * Fr::from(10u64)))?;

    // Strict upper bound: r + s = 9999 with s a 14-bit non-negative witness.
    // Together with the bit-width limits this forces 0 <= r <= 9999
    // (a bare 14-bit range would allow r in [10000, 16383] and accept fee-1).
    let s = FpVar::new_witness(cs.clone(), || {
        let rv = r.value().unwrap_or(Fr::from(0u64));
        Ok(Fr::from(9999u64) - rv)
    })?;
    (&r + &s).enforce_equal(&FpVar::constant(Fr::from(9999u64)))?;

    for x in [&r, &s] {
        let bits = x.to_bits_le()?;
        for bit in bits.iter().skip(14) {
            bit.enforce_equal(&ark_r1cs_std::boolean::Boolean::constant(false))?;
        }
    }
    let _ = cs;
    Ok(())
}

impl ConstraintSynthesizer<Fr> for SpendArithmeticCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let amount = FpVar::new_witness(cs.clone(), || Ok(self.amount))?;
        let fee = FpVar::new_witness(cs.clone(), || Ok(self.fee))?;
        let sender_old = FpVar::new_witness(cs.clone(), || Ok(self.sender_old))?;
        let sender_new = FpVar::new_witness(cs.clone(), || Ok(self.sender_new))?;
        let recipient_old = FpVar::new_witness(cs.clone(), || Ok(self.recipient_old))?;
        let recipient_new = FpVar::new_witness(cs.clone(), || Ok(self.recipient_new))?;
        let treasury_old = FpVar::new_witness(cs.clone(), || Ok(self.treasury_old))?;
        let treasury_new = FpVar::new_witness(cs.clone(), || Ok(self.treasury_new))?;

        for x in [
            &amount,
            &fee,
            &sender_old,
            &sender_new,
            &recipient_old,
            &recipient_new,
            &treasury_old,
            &treasury_new,
        ] {
            enforce_u64(cs.clone(), x)?;
        }

        enforce_fee_policy(cs.clone(), &amount, &fee)?;

        // State equations.
        (&sender_new + &amount + &fee).enforce_equal(&sender_old)?;
        (&recipient_old + &amount).enforce_equal(&recipient_new)?;
        (&treasury_old + &fee).enforce_equal(&treasury_new)?;

        // Conservation.
        let old_total = &sender_old + &recipient_old + &treasury_old;
        let new_total = &sender_new + &recipient_new + &treasury_new;
        old_total.enforce_equal(&new_total)?;

        Ok(())
    }
}

#[cfg(test)]
mod arithmetic_tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    fn honest(amount: u64, sender_old: u64, recipient_old: u64, treasury_old: u64) -> SpendArithmeticCircuit {
        let fee = expected_fee(amount);
        SpendArithmeticCircuit {
            amount: Fr::from(amount),
            fee: Fr::from(fee),
            sender_old: Fr::from(sender_old),
            sender_new: Fr::from(sender_old - amount - fee),
            recipient_old: Fr::from(recipient_old),
            recipient_new: Fr::from(recipient_old + amount),
            treasury_old: Fr::from(treasury_old),
            treasury_new: Fr::from(treasury_old + fee),
        }
    }

    #[test]
    fn c4_exact_fee_accepted() {
        let c = honest(1_000_000, 2_000_000, 0, 0);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
    }

    #[test]
    fn c4_fee_plus_one_rejected() {
        let mut c = honest(1_000_000, 2_000_000, 0, 0);
        c.fee = Fr::from(expected_fee(1_000_000) + 1);
        // Adjust balances so only fee policy breaks if we're not careful —
        // keep balances consistent with wrong fee so fee constraint is the failure mode.
        c.sender_new = Fr::from(2_000_000u64 - 1_000_000 - (expected_fee(1_000_000) + 1));
        c.treasury_new = Fr::from(expected_fee(1_000_000) + 1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c4_fee_minus_one_rejected() {
        let fee = expected_fee(1_000_000);
        assert!(fee > 0);
        let mut c = honest(1_000_000, 2_000_000, 0, 0);
        c.fee = Fr::from(fee - 1);
        c.sender_new = Fr::from(2_000_000u64 - 1_000_000 - (fee - 1));
        c.treasury_new = Fr::from(fee - 1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c5_amount_above_u64_rejected() {
        // amount = 2^64 as field element → bit 64 set → enforce_u64 fails
        let mut c = honest(1000, 10_000, 0, 0);
        use ark_ff::{PrimeField};
        let mut repr = Fr::from(0u64).into_repr();
        // set bit 64: limb index 1 bit 0 in 64-bit limbs
        repr.0[1] = 1;
        c.amount = Fr::from_repr(repr).unwrap();
        let cs = ConstraintSystem::<Fr>::new_ref();
        let _ = c.generate_constraints(cs.clone());
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c6_sender_equation_enforced() {
        let mut c = honest(1000, 10_000, 0, 0);
        c.sender_new = Fr::from(0u64); // wrong
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c6_conservation_enforced() {
        let mut c = honest(1000, 10_000, 5_000, 100);
        c.recipient_new = Fr::from(5_000u64 + 1000 + 1); // extra unit
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }
}
