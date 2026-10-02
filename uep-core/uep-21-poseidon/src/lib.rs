//! UEP-21: real Poseidon BN254 integration for native hashing + R1CS.
//!
//! The parameter construction follows the Arkworks/Webb gadget architecture:
//! BN254 field, alpha=5, width=3, with the Circom-compatible round structure.
//! The same native parameters are injected into the R1CS Poseidon gadget.

use ark_bn254::Fr;
use ark_ff::PrimeField;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar};
use arkworks_native_gadgets::poseidon::{sbox::PoseidonSbox, FieldHasher, Poseidon, PoseidonParameters};
use arkworks_r1cs_gadgets::poseidon::{FieldHasherGadget, PoseidonGadget};
use arkworks_utils::{bytes_matrix_to_f, bytes_vec_to_f, poseidon_params::setup_poseidon_params, Curve};

/// UEP's canonical Poseidon instance for BN254.
///
/// Width 3 means two field inputs plus one capacity element.
/// Alpha = 5 is the BN254/Circom-friendly S-box exponent.
pub fn uep_poseidon_parameters() -> PoseidonParameters<Fr> {
    let data = setup_poseidon_params(Curve::Bn254, 5, 3)
        .expect("BN254 Poseidon parameters must be available");

    PoseidonParameters {
        mds_matrix: bytes_matrix_to_f(&data.mds),
        round_keys: bytes_vec_to_f(&data.rounds),
        full_rounds: data.full_rounds,
        partial_rounds: data.partial_rounds,
        sbox: PoseidonSbox(data.exp),
        width: data.width,
    }
}

/// Native UEP hash of exactly two field elements.
pub fn uep_poseidon_hash(a: Fr, b: Fr) -> Fr {
    let hasher = Poseidon::<Fr>::new(uep_poseidon_parameters());
    hasher.hash(&[a, b]).expect("two inputs are valid for width=3")
}

/// Frozen UEP-26 domain tags.
pub const D_ACCOUNT: u64 = 1;
pub const D_NULLIFIER: u64 = 2;
pub const D_MERKLE: u64 = 3;
pub const D_LEAF: u64 = 4;
pub const D_TX: u64 = 5;

/// Frozen domain composition: H(d,a,b) = Poseidon(Poseidon(Fr(d), a), b).
pub fn uep_domain_hash(domain: u64, a: Fr, b: Fr) -> Fr {
    let inner = uep_poseidon_hash(Fr::from(domain), a);
    uep_poseidon_hash(inner, b)
}

/// Frozen note commitment (UEP-26-HASH-PARAMETERS-FREEZE.md §4.2).
pub fn uep_note_commitment(owner: Fr, asset: Fr, amount: Fr, blinding: Fr) -> Fr {
    let inner_asset = uep_domain_hash(D_LEAF, asset, amount);
    let payload = uep_domain_hash(D_LEAF, owner, inner_asset);
    uep_domain_hash(D_LEAF, payload, blinding)
}

pub fn uep_note_nonce(commitment: Fr, blinding: Fr) -> Fr {
    uep_domain_hash(D_LEAF, commitment, blinding)
}

pub fn uep_note_nullifier(secret: Fr, nonce: Fr) -> Fr {
    uep_domain_hash(D_NULLIFIER, secret, nonce)
}

/// LEGACY / experimental (pre–UEP-26 domain composition).
///
/// Uses raw two-input Poseidon without the frozen domain tags.
/// Not part of the normative UEP-26 note/nullifier/Merkle path.
/// Prefer `uep_domain_hash` / `H_LEAF` / `H_NULLIFIER` / `H_MERKLE` for protocol work.
pub fn state_commitment(balance: Fr, ruleset: Fr, policy: Fr) -> Fr {
    let inner = uep_poseidon_hash(balance, ruleset);
    uep_poseidon_hash(inner, policy)
}

/// LEGACY / experimental (pre–UEP-26 domain composition).
/// Prefer `uep_note_nullifier` / `H_NULLIFIER` for protocol nullifiers.
pub fn state_nullifier(secret: Fr, state_root: Fr, amount: Fr) -> Fr {
    let inner = uep_poseidon_hash(secret, state_root);
    uep_poseidon_hash(inner, amount)
}

/// LEGACY helper: raw Poseidon parent without domain tag.
/// Prefer `uep_domain_hash(D_MERKLE, left, right)` for UEP-26 Merkle nodes.
pub fn merkle_parent(left: Fr, right: Fr) -> Fr {
    uep_poseidon_hash(left, right)
}

/// Proves that a private pair (a,b) hashes to a public Poseidon digest.
#[derive(Clone)]
pub struct PoseidonHashCircuit {
    pub a: Fr,
    pub b: Fr,
    pub expected: Fr,
}

impl ConstraintSynthesizer<Fr> for PoseidonHashCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let a = FpVar::new_witness(cs.clone(), || Ok(self.a))?;
        let b = FpVar::new_witness(cs.clone(), || Ok(self.b))?;
        let expected = FpVar::new_input(cs.clone(), || Ok(self.expected))?;

        let native = Poseidon::<Fr>::new(uep_poseidon_parameters());
        let gadget: PoseidonGadget<Fr> = FieldHasherGadget::<Fr>::from_native(
            &mut cs.clone(),
            native,
        )?;

        let computed = gadget.hash(&[a, b])?;
        computed.enforce_equal(&expected)?;
        Ok(())
    }
}

/// Proves `expected = H(domain, a, b)` with the frozen nested Poseidon composition.
#[derive(Clone)]
pub struct DomainHashCircuit {
    pub domain: u64,
    pub a: Fr,
    pub b: Fr,
    pub expected: Fr,
}

impl ConstraintSynthesizer<Fr> for DomainHashCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let a = FpVar::new_witness(cs.clone(), || Ok(self.a))?;
        let b = FpVar::new_witness(cs.clone(), || Ok(self.b))?;
        let expected = FpVar::new_input(cs.clone(), || Ok(self.expected))?;
        let d = FpVar::new_constant(cs.clone(), Fr::from(self.domain))?;

        let native = Poseidon::<Fr>::new(uep_poseidon_parameters());
        let gadget: PoseidonGadget<Fr> = FieldHasherGadget::<Fr>::from_native(
            &mut cs.clone(),
            native,
        )?;

        let inner = gadget.hash(&[d, a])?;
        let computed = gadget.hash(&[inner, b])?;
        computed.enforce_equal(&expected)?;
        Ok(())
    }
}

/// Poseidon2 is deliberately kept behind a separate API boundary.
/// Its parameter set is not interchangeable with Poseidon's.
pub trait UepHashBackend {
    fn hash2(a: Fr, b: Fr) -> Fr;
}

pub struct PoseidonBackend;
impl UepHashBackend for PoseidonBackend {
    fn hash2(a: Fr, b: Fr) -> Fr { uep_poseidon_hash(a, b) }
}

/// Poseidon2 is out of scope for UEP-26. Calling it is a protocol error.
pub struct Poseidon2Backend;
impl UepHashBackend for Poseidon2Backend {
    fn hash2(_a: Fr, _b: Fr) -> Fr {
        panic!("UEP-26: Poseidon2 is CONCEPTUAL and must not be used as a hash backend");
    }
}
