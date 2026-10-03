//! Reusable UEP-26 domain-separated hash composition.
//!
//! Status: composition layer + **bound Poseidon backend** (UEP-21).
//!
//! Formula (frozen):
//!
//!   H(d, a, b) = Hash2( Hash2(Fr(d), a), b )
//!
//! The permutation is supplied by a `Hash2` / `Hash2Gadget` implementation.
//! `UepPoseidon` is the production binding to UEP-21 Poseidon BN254 t=3 α=5.
//! `StructuralTestHash` remains a non-cryptographic stub for composition tests only.
//! A dummy Hash2 must never be labeled IMPLEMENTED Poseidon.

use ark_bn254::Fr;
use ark_r1cs_std::{
    alloc::AllocVar,
    eq::EqGadget,
    fields::fp::FpVar,
};
use ark_relations::r1cs::{ConstraintSystemRef, SynthesisError};
use arkworks_native_gadgets::poseidon::Poseidon;
use arkworks_r1cs_gadgets::poseidon::{FieldHasherGadget, PoseidonGadget};
use uep21_poseidon_r1cs::{uep_poseidon_hash, uep_poseidon_parameters};

/// Frozen domain tags (UEP-26-HASH-PARAMETERS-FREEZE.md §2).
pub const D_ACCOUNT: u64 = 1;
pub const D_NULLIFIER: u64 = 2;
pub const D_MERKLE: u64 = 3;
pub const D_LEAF: u64 = 4;
pub const D_TX: u64 = 5;

/// Two-input hash used by the frozen composition.
pub trait Hash2 {
    fn hash2(a: Fr, b: Fr) -> Fr;
}

/// In-circuit two-input hash.
pub trait Hash2Gadget {
    fn hash2(
        cs: ConstraintSystemRef<Fr>,
        a: &FpVar<Fr>,
        b: &FpVar<Fr>,
    ) -> Result<FpVar<Fr>, SynthesisError>;
}

/// Native domain-separated hash. Permutation is injected, never invented.
pub fn domain_hash<H: Hash2>(domain: u64, a: Fr, b: Fr) -> Fr {
    let d = Fr::from(domain);
    let inner = H::hash2(d, a);
    H::hash2(inner, b)
}

pub fn h_account<H: Hash2>(secret: Fr, salt: Fr) -> Fr {
    domain_hash::<H>(D_ACCOUNT, secret, salt)
}

/// State-tree key of a balance leaf: H_ACCOUNT(account_id, asset_id).
/// The same key the public ledger uses for its SMT (`hAccount(account, asset)`),
/// so every (account, asset) pair has its own leaf (V47-02).
pub fn state_key<H: Hash2>(account: Fr, asset: Fr) -> Fr {
    domain_hash::<H>(D_ACCOUNT, account, asset)
}

pub fn h_nullifier<H: Hash2>(secret: Fr, nonce: Fr) -> Fr {
    domain_hash::<H>(D_NULLIFIER, secret, nonce)
}

pub fn h_merkle<H: Hash2>(left: Fr, right: Fr) -> Fr {
    domain_hash::<H>(D_MERKLE, left, right)
}

pub fn h_leaf<H: Hash2>(a: Fr, b: Fr) -> Fr {
    domain_hash::<H>(D_LEAF, a, b)
}

pub fn h_tx<H: Hash2>(a: Fr, b: Fr) -> Fr {
    domain_hash::<H>(D_TX, a, b)
}

/// Left-fold under a domain (UEP-26 freeze).
/// H_fold(d, []) = H(d,0,0); H_fold(d,[x0]) = x0;
/// H_fold(d,[x0..xk]) = H(d, H_fold(d,[x0..x{k-1}]), xk)
pub fn h_fold<H: Hash2>(domain: u64, items: &[Fr]) -> Fr {
    if items.is_empty() {
        return domain_hash::<H>(domain, Fr::from(0u64), Fr::from(0u64));
    }
    if items.len() == 1 {
        return items[0];
    }
    let mut acc = items[0];
    for x in items.iter().skip(1) {
        acc = domain_hash::<H>(domain, acc, *x);
    }
    acc
}

/// Canonical transaction commitment (public-input binding).
/// Fold order: ENCODING_VERSION=1 then the first 11 public fields (excl. commitment itself).
pub const ENCODING_VERSION: u64 = 2;

pub fn tx_commitment<H: Hash2>(
    old_state_root: Fr,
    new_state_root: Fr,
    old_nullifier_root: Fr,
    new_nullifier_root: Fr,
    sender_id: Fr,
    recipient_id: Fr,
    treasury_id: Fr,
    asset_id: Fr,
    amount: Fr,
    fee: Fr,
    nullifier: Fr,
    domain_id: Fr,
) -> Fr {
    h_fold::<H>(
        D_TX,
        &[
            Fr::from(ENCODING_VERSION),
            old_state_root,
            new_state_root,
            old_nullifier_root,
            new_nullifier_root,
            sender_id,
            recipient_id,
            treasury_id,
            asset_id,
            amount,
            fee,
            nullifier,
            domain_id,
        ],
    )
}

/// Frozen note commitment encoding (freeze §4.2).
pub fn note_commitment<H: Hash2>(owner: Fr, asset: Fr, amount: Fr, blinding: Fr) -> Fr {
    let inner_asset = h_leaf::<H>(asset, amount);
    let payload = h_leaf::<H>(owner, inner_asset);
    h_leaf::<H>(payload, blinding)
}

pub fn note_nonce<H: Hash2>(commitment: Fr, blinding: Fr) -> Fr {
    h_leaf::<H>(commitment, blinding)
}

/// In-circuit domain hash using the same nested composition.
pub fn domain_hash_gadget<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    domain: u64,
    a: &FpVar<Fr>,
    b: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let d = FpVar::new_constant(cs.clone(), Fr::from(domain))?;
    let inner = G::hash2(cs.clone(), &d, a)?;
    G::hash2(cs, &inner, b)
}

/// Constrains `out = H(domain, a, b)` for a supplied Hash2 gadget.
pub fn enforce_domain_hash<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    domain: u64,
    a: &FpVar<Fr>,
    b: &FpVar<Fr>,
    out: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    let computed = domain_hash_gadget::<G>(cs, domain, a, b)?;
    computed.enforce_equal(out)
}

/// In-circuit left-fold under a domain.
pub fn h_fold_gadget<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    domain: u64,
    items: &[FpVar<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    if items.is_empty() {
        let z = FpVar::new_constant(cs.clone(), Fr::from(0u64))?;
        return domain_hash_gadget::<G>(cs, domain, &z, &z);
    }
    if items.len() == 1 {
        return Ok(items[0].clone());
    }
    let mut acc = items[0].clone();
    for x in items.iter().skip(1) {
        acc = domain_hash_gadget::<G>(cs.clone(), domain, &acc, x)?;
    }
    Ok(acc)
}

pub fn enforce_tx_commitment<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    expected: &FpVar<Fr>,
    parts: &[FpVar<Fr>], // already includes Fr(ENCODING_VERSION) as first element or we prepend
) -> Result<(), SynthesisError> {
    let computed = h_fold_gadget::<G>(cs, D_TX, parts)?;
    computed.enforce_equal(expected)
}

// ---------------------------------------------------------------------------
// Production binding: UEP-21 Poseidon
// ---------------------------------------------------------------------------

/// Canonical UEP-26 Poseidon backend (BN254, t=3, α=5).
///
/// Native and R1CS paths use the same parameter set from
/// `uep21_poseidon_r1cs::uep_poseidon_parameters()`.
pub struct UepPoseidon;

impl Hash2 for UepPoseidon {
    fn hash2(a: Fr, b: Fr) -> Fr {
        uep_poseidon_hash(a, b)
    }
}

impl Hash2Gadget for UepPoseidon {
    fn hash2(
        cs: ConstraintSystemRef<Fr>,
        a: &FpVar<Fr>,
        b: &FpVar<Fr>,
    ) -> Result<FpVar<Fr>, SynthesisError> {
        let native = Poseidon::<Fr>::new(uep_poseidon_parameters());
        let gadget: PoseidonGadget<Fr> =
            FieldHasherGadget::<Fr>::from_native(&mut cs.clone(), native)?;
        gadget.hash(&[a.clone(), b.clone()])
    }
}

// ---------------------------------------------------------------------------
// Structural test hasher (NOT Poseidon)
// ---------------------------------------------------------------------------

/// Structural test hasher. NOT Poseidon. Used only to verify that the
/// composition nests two Hash2 calls in the documented order.
/// Status: TEST HARNESS / STUB permutation.
pub struct StructuralTestHash;

impl Hash2 for StructuralTestHash {
    fn hash2(a: Fr, b: Fr) -> Fr {
        // Distinct, order-sensitive polynomial. Not a cryptographic hash.
        a + a + b + Fr::from(1u64)
    }
}

impl Hash2Gadget for StructuralTestHash {
    fn hash2(
        _cs: ConstraintSystemRef<Fr>,
        a: &FpVar<Fr>,
        b: &FpVar<Fr>,
    ) -> Result<FpVar<Fr>, SynthesisError> {
        Ok(a + a + b + Fr::from(1u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn composition_is_order_and_domain_sensitive() {
        let a = Fr::from(1u64);
        let b = Fr::from(2u64);
        let h1 = domain_hash::<StructuralTestHash>(D_LEAF, a, b);
        let h2 = domain_hash::<StructuralTestHash>(D_LEAF, b, a);
        let h3 = domain_hash::<StructuralTestHash>(D_TX, a, b);
        assert_ne!(h1, h2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn gadget_matches_native_structural_hasher() {
        let a = Fr::from(7u64);
        let b = Fr::from(11u64);
        let expected = domain_hash::<StructuralTestHash>(D_NULLIFIER, a, b);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let a_v = FpVar::new_witness(cs.clone(), || Ok(a)).unwrap();
        let b_v = FpVar::new_witness(cs.clone(), || Ok(b)).unwrap();
        let out_v = FpVar::new_input(cs.clone(), || Ok(expected)).unwrap();
        enforce_domain_hash::<StructuralTestHash>(cs.clone(), D_NULLIFIER, &a_v, &b_v, &out_v)
            .unwrap();
        assert!(cs.is_satisfied().unwrap());
    }

    #[test]
    fn gadget_rejects_wrong_digest() {
        let a = Fr::from(7u64);
        let b = Fr::from(11u64);
        let expected = domain_hash::<StructuralTestHash>(D_NULLIFIER, a, b) + Fr::from(1u64);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let a_v = FpVar::new_witness(cs.clone(), || Ok(a)).unwrap();
        let b_v = FpVar::new_witness(cs.clone(), || Ok(b)).unwrap();
        let out_v = FpVar::new_input(cs.clone(), || Ok(expected)).unwrap();
        enforce_domain_hash::<StructuralTestHash>(cs.clone(), D_NULLIFIER, &a_v, &b_v, &out_v)
            .unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn note_path_binds_all_fields() {
        let owner = Fr::from(1u64);
        let asset = Fr::from(2u64);
        let amount = Fr::from(1000u64);
        let blinding = Fr::from(3u64);
        let c1 = note_commitment::<StructuralTestHash>(owner, asset, amount, blinding);
        let c2 = note_commitment::<StructuralTestHash>(owner, asset, Fr::from(1001u64), blinding);
        assert_ne!(c1, c2);
        let n1 = note_nonce::<StructuralTestHash>(c1, blinding);
        let n2 = note_nonce::<StructuralTestHash>(c1, Fr::from(4u64));
        assert_ne!(n1, n2);
    }

    // ---- Poseidon binding tests (cross-check against UEP-21 + golden vectors) ----

    #[test]
    fn uep_poseidon_matches_uep21_native() {
        let a = Fr::from(1u64);
        let b = Fr::from(2u64);
        let out = <UepPoseidon as Hash2>::hash2(a, b);
        let expected = uep21_poseidon_r1cs::uep_poseidon_hash(a, b);
        assert_eq!(out, expected);
    }

    #[test]
    fn uep_poseidon_domain_matches_uep21() {
        let out = domain_hash::<UepPoseidon>(D_ACCOUNT, Fr::from(1u64), Fr::from(2u64));
        let expected = uep21_poseidon_r1cs::uep_domain_hash(D_ACCOUNT, Fr::from(1u64), Fr::from(2u64));
        assert_eq!(out, expected);
    }

    #[test]
    fn uep_poseidon_gadget_matches_native() {
        let a = Fr::from(7u64);
        let b = Fr::from(11u64);
        let expected = domain_hash::<UepPoseidon>(D_NULLIFIER, a, b);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let a_v = FpVar::new_witness(cs.clone(), || Ok(a)).unwrap();
        let b_v = FpVar::new_witness(cs.clone(), || Ok(b)).unwrap();
        let out_v = FpVar::new_input(cs.clone(), || Ok(expected)).unwrap();
        enforce_domain_hash::<UepPoseidon>(cs.clone(), D_NULLIFIER, &a_v, &b_v, &out_v).unwrap();
        assert!(cs.is_satisfied().unwrap());
        assert!(cs.num_constraints() > 100); // real Poseidon has many constraints
    }

    #[test]
    fn uep_poseidon_gadget_rejects_wrong_digest() {
        let a = Fr::from(7u64);
        let b = Fr::from(11u64);
        let expected = domain_hash::<UepPoseidon>(D_NULLIFIER, a, b) + Fr::from(1u64);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let a_v = FpVar::new_witness(cs.clone(), || Ok(a)).unwrap();
        let b_v = FpVar::new_witness(cs.clone(), || Ok(b)).unwrap();
        let out_v = FpVar::new_input(cs.clone(), || Ok(expected)).unwrap();
        enforce_domain_hash::<UepPoseidon>(cs.clone(), D_NULLIFIER, &a_v, &b_v, &out_v).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn uep_poseidon_note_path_matches_uep21() {
        let owner = Fr::from(1u64);
        let asset = Fr::from(2u64);
        let amount = Fr::from(1000u64);
        let blinding = Fr::from(3u64);
        let c = note_commitment::<UepPoseidon>(owner, asset, amount, blinding);
        let expected = uep21_poseidon_r1cs::uep_note_commitment(owner, asset, amount, blinding);
        assert_eq!(c, expected);
    }
}
