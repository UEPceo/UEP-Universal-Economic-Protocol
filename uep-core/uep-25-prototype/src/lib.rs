//! UEP-25: prototype atomic state-transition layer.
//!
//! This crate focuses on the invariant-bearing core:
//! - ownership binding,
//! - Poseidon-style commitment interface,
//! - fee accounting,
//! - three-leaf atomic state transition,
//! - nullifier lifecycle,
//! - sparse-Merkle path model,
//! - adversarial validation.
//!
//! The proof backend is intentionally separated from the state machine.
//! A production implementation must freeze a concrete Poseidon parameter set,
//! concrete SMT serialization, domain separation and circuit parameters before
//! generating a long-lived Groth16 verification key.

pub mod fee;
pub mod hash;
pub mod smt;
pub mod transition;
pub mod nullifier;
pub mod circuit;
pub mod attack;

pub const FEE_BPS: u64 = 10;       // 0.1%
pub const BPS_DENOM: u64 = 10_000;
pub const ACCOUNT_DEPTH: usize = 32;
pub const NULLIFIER_DEPTH: usize = 32;
