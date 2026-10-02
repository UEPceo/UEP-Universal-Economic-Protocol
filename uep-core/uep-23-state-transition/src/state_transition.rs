//! UEP-23 state transition circuit.
//!
//! This circuit composes:
//!   1. sender leaf membership in old SMT root;
//!   2. sender balance conservation with a 0.1% integer fee;
//!   3. Poseidon treasury commitment;
//!   4. sender leaf replacement and new SMT root;
//!   5. nullifier derivation.
//!
//! IMPORTANT PROTOCOL DECISION:
//! The treasury fee is NOT silently "teleported" into the sender leaf.
//! The state machine exposes `treasury_commitment` as a public effect.
//! A following accumulator transition credits the corresponding treasury
//! balance. This keeps one-leaf SMT transitions simple and makes the fee
//! auditable without requiring a two-leaf Merkle update in this circuit.
//!
//! A future batched circuit can update sender + treasury leaves atomically.

use ark_bn254::Fr;
use ark_ff::PrimeField;
use ark_r1cs_std::{
    alloc::AllocVar,
    boolean::Boolean,
    cmp::CmpGadget,
    eq::EqGadget,
    fields::fp::FpVar,
    select::CondSelectGadget,
    uint64::UInt64,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use arkworks_native_gadgets::poseidon::{
    sbox::PoseidonSbox, FieldHasher, Poseidon, PoseidonParameters,
};
use arkworks_r1cs_gadgets::poseidon::PoseidonGadget;



pub const TREE_DEPTH: usize = 32;
pub const FEE_DIVISOR: u64 = 1_000; // 10 bps = 0.1%, floor(amount / 1000)
pub const REMAINDER_BITS: usize = 10;

/// State leaf = Poseidon(account_id, balance).
///
/// Asset identifiers can be incorporated into account_id (domain-separated
/// canonical encoding) until the multi-asset leaf schema is finalized.
fn leaf_hash(
    gadget: &mut PoseidonGadget<Fr>,
    account_id: FpVar<Fr>,
    balance: FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    gadget.hash(&[account_id, balance])
}

/// Integer fee:
///     amount = fee * 1000 + remainder
///     0 <= remainder < 1000
///
/// This implements floor(amount * 10 / 10000) exactly, avoiding a field-level
/// fractional division and avoiding accidental rejection of amounts that are
/// not multiples of 1000.
fn enforce_fee(
    amount: &UInt64<Fr>,
    fee: &UInt64<Fr>,
    remainder: &UInt64<Fr>,
) -> Result<(), SynthesisError> {
    // Exact integer semantics:
    // amount = 1000 * fee + remainder
    // 0 <= remainder < 1000
    let amount_fp = amount.to_fp()?;
    let fee_fp = fee.to_fp()?;
    let remainder_fp = remainder.to_fp()?;

    let rhs = &fee_fp * Fr::from(FEE_DIVISOR) + &remainder_fp;
    amount_fp.enforce_equal(&rhs)?;

    let lt_1000 =
        remainder.is_lt(&UInt64::constant(FEE_DIVISOR))?;
    lt_1000.enforce_equal(&Boolean::TRUE)?;

    Ok(())
}

/// Calculate an SMT root from a leaf, siblings and direction bits.
pub fn calculate_root(
    mut gadget: PoseidonGadget<Fr>,
    mut current: FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    directions: &[Boolean<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    assert_eq!(siblings.len(), directions.len());

    for (sibling, bit) in siblings.iter().zip(directions.iter()) {
        // bit=0 => current is left child
        // bit=1 => current is right child
        let left = FpVar::conditionally_select(bit, sibling, &current)?;
        let right = FpVar::conditionally_select(bit, &current, sibling)?;
        current = gadget.hash(&[left, right])?;
    }

    Ok(current)
}

/// One-leaf state transition.
///
/// Public inputs:
///   old_root
///   new_root
///   nullifier
///   treasury_commitment
///
/// Witness:
///   account_id, old_balance, new_balance, amount, fee, remainder,
///   secret, nonce, SMT path and path directions.
#[derive(Clone)]
pub struct StateTransitionCircuit {
    pub old_root: Fr,
    pub new_root: Fr,
    pub nullifier: Fr,
    pub treasury_commitment: Fr,

    pub account_id: Fr,
    pub old_balance: u64,
    pub new_balance: u64,
    pub amount: u64,
    pub fee: u64,
    pub remainder: u64,

    pub secret: Fr,
    pub nonce: Fr,
    pub siblings: Vec<Fr>,
    pub directions: Vec<bool>,

    pub hasher: Poseidon<Fr>,
}

impl ConstraintSynthesizer<Fr> for StateTransitionCircuit {
    fn generate_constraints(
        self,
        cs: ConstraintSystemRef<Fr>,
    ) -> Result<(), SynthesisError> {
        if self.siblings.len() != TREE_DEPTH
            || self.directions.len() != TREE_DEPTH
        {
            return Err(SynthesisError::Unsatisfiable);
        }

        let old_root = FpVar::new_input(cs.clone(), || Ok(self.old_root))?;
        let new_root = FpVar::new_input(cs.clone(), || Ok(self.new_root))?;
        let nullifier = FpVar::new_input(cs.clone(), || Ok(self.nullifier))?;
        let treasury_commitment =
            FpVar::new_input(cs.clone(), || Ok(self.treasury_commitment))?;

        let account_id = FpVar::new_witness(cs.clone(), || Ok(self.account_id))?;
        let old_balance_u =
            UInt64::new_witness(cs.clone(), || Ok(self.old_balance))?;
        let new_balance_u =
            UInt64::new_witness(cs.clone(), || Ok(self.new_balance))?;
        let amount_u =
            UInt64::new_witness(cs.clone(), || Ok(self.amount))?;
        let fee_u =
            UInt64::new_witness(cs.clone(), || Ok(self.fee))?;
        let remainder_u =
            UInt64::new_witness(cs.clone(), || Ok(self.remainder))?;

        let old_balance = old_balance_u.to_fp()?;
        let new_balance = new_balance_u.to_fp()?;
        let amount = amount_u.to_fp()?;
        let fee = fee_u.to_fp()?;

        // Conservation:
        // old_balance = new_balance + amount + fee.
        let conserved = &new_balance + &amount + &fee;
        old_balance.enforce_equal(&conserved)?;

        // Fee relation with integer floor semantics.
        enforce_fee(&amount_u, &fee_u, &remainder_u)?;

        let mut gadget = PoseidonGadget::<Fr>::from_native(
            &mut cs.clone(),
            self.hasher.clone(),
        )?;

        // Sender leaf before and after.
        let old_leaf = leaf_hash(&mut gadget, account_id.clone(), old_balance)?;
        let new_leaf = leaf_hash(&mut gadget, account_id, new_balance)?;

        let siblings_vars: Vec<FpVar<Fr>> = self.siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)))
            .collect::<Result<_, _>>()?;

        let direction_vars: Vec<Boolean<Fr>> = self.directions
            .iter()
            .map(|b| Boolean::new_witness(cs.clone(), || Ok(*b)))
            .collect::<Result<_, _>>()?;

        // Same authentication path must lead both old and new leaves to the
        // respective public roots.
        let old_calc = calculate_root(
            PoseidonGadget::from_native(&mut cs.clone(), self.hasher.clone())?,
            old_leaf,
            &siblings_vars,
            &direction_vars,
        )?;
        old_calc.enforce_equal(&old_root)?;

        let new_calc = calculate_root(
            PoseidonGadget::from_native(&mut cs.clone(), self.hasher.clone())?,
            new_leaf,
            &siblings_vars,
            &direction_vars,
        )?;
        new_calc.enforce_equal(&new_root)?;

        // Nullifier = Poseidon(secret, nonce).
        let null_calc = PoseidonGadget::from_native(
            &mut cs.clone(),
            self.hasher.clone(),
        )?
        .hash(&[secret, nonce])?;
        null_calc.enforce_equal(&nullifier)?;

        // Treasury commitment = Poseidon(domain/tresury id, fee).
        // In the final protocol the treasury id is a fixed public constant
        // represented by a domain-separated field element.
        let treasury_id = FpVar::constant(Fr::from(UEP_TREASURY_DOMAIN));
        let fee_commit = PoseidonGadget::from_native(
            &mut cs.clone(),
            self.hasher,
        )?
        .hash(&[treasury_id, fee])?;
        fee_commit.enforce_equal(&treasury_commitment)?;

        Ok(())
    }
}

/// Domain separator for the creator treasury commitment.
/// This is NOT the user's private key or wallet address.
pub const UEP_TREASURY_DOMAIN: u64 = 0x5545505F54524541; // "UEP_TREA"
