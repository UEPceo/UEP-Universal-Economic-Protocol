//! UEP-25 circuit boundary.
//!
//! The production R1CS must contain:
//! 1. sender account-ID derivation,
//! 2. nullifier derivation,
//! 3. sender/recipient/treasury SMT membership,
//! 4. three synchronized SMT updates,
//! 5. nullifier-tree insertion,
//! 6. fee arithmetic,
//! 7. conservation,
//! 8. public old/new roots and transaction commitment.
//!
//! This file defines the witness/public-input contract. It intentionally does
//! not pretend that a generated Groth16 proof exists until the exact hash gadget
//! and SMT gadget versions are frozen and test-vector compatible.

use ark_bn254::Fr;

#[derive(Clone, Debug)]
pub struct PublicInputs {
    pub old_state_root: Fr,
    pub new_state_root: Fr,
    pub old_nullifier_root: Fr,
    pub new_nullifier_root: Fr,
    pub sender_id: Fr,
    pub recipient_id: Fr,
    pub treasury_id: Fr,
    pub nullifier: Fr,
    pub amount: Fr,
    pub fee: Fr,
    pub transaction_commitment: Fr,
}

#[derive(Clone, Debug)]
pub struct Witness {
    pub sender_secret: Fr,
    pub sender_salt: Fr,
    pub nonce: Fr,
    pub sender_old_leaf: Fr,
    pub sender_new_leaf: Fr,
    pub recipient_old_leaf: Fr,
    pub recipient_new_leaf: Fr,
    pub treasury_old_leaf: Fr,
    pub treasury_new_leaf: Fr,
    pub sender_path: Vec<Fr>,
    pub recipient_path: Vec<Fr>,
    pub treasury_path: Vec<Fr>,
    pub nullifier_path: Vec<Fr>,
}
