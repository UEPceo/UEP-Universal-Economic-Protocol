//! UEP-26 SMT direction bits + membership / update gadgets.
//!
//! Status: first R1CS layer for Merkle paths (UEP-26.6).
//!
//! Normative path semantics (matching UEP-25 / wallet TS):
//! - Depth D (protocol = 32; tests may use smaller D).
//! - `index_bits[i]` is the LSB of the leaf index after i right-shifts.
//! - If `index_bits[i] == false`: parent = H_MERKLE(cur, sibling)  (cur on left)
//! - If `index_bits[i] == true`:  parent = H_MERKLE(sibling, cur)  (cur on right)
//!
//! Direction bits are **not** free witnesses: they are derived from the leaf
//! index via boolean bit decomposition and bound with `enforce_equal`.

use ark_bn254::Fr;
use ark_r1cs_std::{
    alloc::AllocVar,
    boolean::Boolean,
    eq::EqGadget,
    fields::{fp::FpVar, FieldVar},
    select::CondSelectGadget,
    ToBitsGadget,
};
use ark_relations::r1cs::{ConstraintSystemRef, SynthesisError};

use crate::hash_gadget::{domain_hash_gadget, Hash2Gadget, D_MERKLE, UepPoseidon};

/// Protocol SMT depth (account + nullifier trees).
pub const SMT_DEPTH: usize = 32;

/// Empty leaf frozen by UEP-26: Fr(0).
pub const EMPTY_LEAF: u64 = 0;

/// Native path (same bit convention as TS / UEP-25).
#[derive(Clone, Debug)]
pub struct MerklePathNative {
    pub siblings: Vec<Fr>,
    pub index_bits: Vec<bool>,
}

impl MerklePathNative {
    pub fn depth(&self) -> usize {
        self.siblings.len()
    }
}

/// Compute Merkle root from leaf + path (native).
pub fn root_from_path_native(leaf: Fr, path: &MerklePathNative) -> Fr {
    let mut cur = leaf;
    for (i, sib) in path.siblings.iter().enumerate() {
        cur = if path.index_bits[i] {
            // cur on the right
            crate::hash_gadget::h_merkle::<UepPoseidon>(*sib, cur)
        } else {
            crate::hash_gadget::h_merkle::<UepPoseidon>(cur, *sib)
        };
    }
    cur
}

/// Extract the low `depth` LSBs of an index as direction bits (LSB-first).
pub fn index_to_direction_bits(index: u64, depth: usize) -> Vec<bool> {
    let mut bits = Vec::with_capacity(depth);
    let mut idx = index;
    for _ in 0..depth {
        bits.push((idx & 1) == 1);
        idx >>= 1;
    }
    bits
}

/// Constrain `index == low \`depth\` bits of `value` (LE).
/// Used for canonical SMT addressing: indexOf(id) = id.lowBits(depth).
pub fn enforce_low_bits_index(
    cs: ConstraintSystemRef<Fr>,
    value: &FpVar<Fr>,
    index: &FpVar<Fr>,
    depth: usize,
) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    let mut acc = FpVar::<Fr>::zero();
    let mut coeff = Fr::from(1u64);
    for bit in bits.iter().take(depth) {
        acc += FpVar::from(bit.clone()) * coeff;
        coeff = coeff + coeff;
    }
    acc.enforce_equal(index)?;
    let _ = &cs;
    Ok(())
}

/// Constrain `a != b` (both field elements): there is an inverse of `a - b`.
pub fn enforce_not_equal(
    cs: ConstraintSystemRef<Fr>,
    a: &FpVar<Fr>,
    b: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    use ark_ff::Field;
    use ark_r1cs_std::R1CSVar;
    let diff = a - b;
    let inv = FpVar::new_witness(cs, || {
        let d = diff.value()?;
        // Equal inputs have no inverse: assign 0 so the system is unsatisfied
        // (same failure mode as the other checks) instead of aborting synthesis.
        Ok(d.inverse().unwrap_or_else(|| Fr::from(0u64)))
    })?;
    (diff * inv).enforce_equal(&FpVar::one())
}

/// Native state-tree index of an (account, asset) balance leaf at depth `depth`:
/// the low bits of `state_key(account, asset)`.
pub fn state_index<H: crate::hash_gadget::Hash2>(account: Fr, asset: Fr, depth: usize) -> u64 {
    low_bits_u64(crate::hash_gadget::state_key::<H>(account, asset), depth)
}

/// Native helper: low `depth` bits of a field element as u64 (depth <= 64).
pub fn low_bits_u64(value: Fr, depth: usize) -> u64 {
    use ark_ff::{BigInteger, PrimeField};
    let bytes = value.into_repr().to_bytes_le();
    let mut x = 0u64;
    let nbytes = (depth + 7) / 8;
    for (j, byte) in bytes.iter().take(nbytes).enumerate() {
        x |= (*byte as u64) << (8 * j);
    }
    if depth < 64 {
        x & ((1u64 << depth) - 1)
    } else {
        x
    }
}

/// Constrain that `bits` are exactly the low `depth` bits of `index`.
///
/// - Each bit is boolean (0/1).
/// - Reconstructing Σ bit_i · 2^i equals `index` (as a field element).
/// - Bits beyond `depth` of a full LE decomposition of `index` are forced to 0
///   when `index` is allocated with a tight range; callers should also range-
///   constrain the index for production.
pub fn enforce_direction_bits_from_index(
    cs: ConstraintSystemRef<Fr>,
    index: &FpVar<Fr>,
    bits: &[Boolean<Fr>],
) -> Result<(), SynthesisError> {
    let depth = bits.len();
    // Reconstruct index from claimed direction bits.
    let mut acc = FpVar::<Fr>::zero();
    let mut coeff = Fr::from(1u64);
    for bit in bits.iter() {
        acc += FpVar::from(bit.clone()) * coeff;
        coeff = coeff + coeff; // *2
    }
    acc.enforce_equal(index)?;

    // Optional: ensure index fits in `depth` bits by requiring higher bits of
    // the field decomposition of index to be zero when depth < 254.
    // For depth=32 this is the protocol account index space.
    if depth < 254 {
        let all_bits = index.to_bits_le()?;
        for bit in all_bits.iter().skip(depth) {
            bit.enforce_equal(&Boolean::constant(false))?;
        }
        let _ = &cs;
    }
    Ok(())
}

/// Allocate direction bits as witnesses and bind them to `index`.
pub fn allocate_direction_bits(
    cs: ConstraintSystemRef<Fr>,
    index: &FpVar<Fr>,
    depth: usize,
    native_bits: Option<&[bool]>,
) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let mut bits = Vec::with_capacity(depth);
    for i in 0..depth {
        let b = Boolean::new_witness(cs.clone(), || {
            // Witness hint only; constraints re-bind bits to `index`.
            Ok(native_bits.map(|nb| nb[i]).unwrap_or(false))
        })?;
        bits.push(b);
    }
    enforce_direction_bits_from_index(cs, index, &bits)?;
    Ok(bits)
}

/// One Merkle step: parent = H_MERKLE(left, right) with direction select.
///
/// `bit == false` → left=cur, right=sibling
/// `bit == true`  → left=sibling, right=cur
pub fn merkle_parent_gadget<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    cur: &FpVar<Fr>,
    sibling: &FpVar<Fr>,
    bit: &Boolean<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    // left = bit ? sibling : cur
    // right = bit ? cur : sibling
    let left = CondSelectGadget::conditionally_select(bit, sibling, cur)?;
    let right = CondSelectGadget::conditionally_select(bit, cur, sibling)?;
    domain_hash_gadget::<G>(cs, D_MERKLE, &left, &right)
}

/// Compute root from leaf + siblings + direction bits (already constrained).
pub fn root_from_path_gadget<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    leaf: &FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    bits: &[Boolean<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    assert_eq!(siblings.len(), bits.len());
    let mut cur = leaf.clone();
    for (sib, bit) in siblings.iter().zip(bits.iter()) {
        cur = merkle_parent_gadget::<G>(cs.clone(), &cur, sib, bit)?;
    }
    Ok(cur)
}

/// Enforce membership: Merkle(leaf, path) = expected_root, with direction bits
/// bound to `index`.
pub fn enforce_membership<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    expected_root: &FpVar<Fr>,
    leaf: &FpVar<Fr>,
    index: &FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    native_bits: Option<&[bool]>,
) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let depth = siblings.len();
    let bits = allocate_direction_bits(cs.clone(), index, depth, native_bits)?;
    let root = root_from_path_gadget::<G>(cs, leaf, siblings, &bits)?;
    root.enforce_equal(expected_root)?;
    Ok(bits)
}

/// Enforce update on the **same** path: old and new leaves share siblings +
/// direction bits derived from `index`.
pub fn enforce_update<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    old_root: &FpVar<Fr>,
    new_root: &FpVar<Fr>,
    old_leaf: &FpVar<Fr>,
    new_leaf: &FpVar<Fr>,
    index: &FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    native_bits: Option<&[bool]>,
) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let depth = siblings.len();
    let bits = allocate_direction_bits(cs.clone(), index, depth, native_bits)?;
    let computed_old = root_from_path_gadget::<G>(cs.clone(), old_leaf, siblings, &bits)?;
    computed_old.enforce_equal(old_root)?;
    let computed_new = root_from_path_gadget::<G>(cs, new_leaf, siblings, &bits)?;
    computed_new.enforce_equal(new_root)?;
    Ok(bits)
}

/// Nullifier insertion: old leaf must be EMPTY, new leaf is the nullifier leaf.
pub fn enforce_nullifier_insert<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    old_root: &FpVar<Fr>,
    new_root: &FpVar<Fr>,
    nullifier_leaf: &FpVar<Fr>,
    index: &FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    native_bits: Option<&[bool]>,
) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let empty = FpVar::new_constant(cs.clone(), Fr::from(EMPTY_LEAF))?;
    enforce_update::<G>(
        cs,
        old_root,
        new_root,
        &empty,
        nullifier_leaf,
        index,
        siblings,
        native_bits,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash_gadget::{h_merkle, StructuralTestHash};
    use ark_relations::r1cs::ConstraintSystem;

    /// Tiny depth-3 tree with structural hasher for fast tests.
    fn structural_parent(left: Fr, right: Fr) -> Fr {
        h_merkle::<StructuralTestHash>(left, right)
    }

    fn structural_root(leaf: Fr, siblings: &[Fr], bits: &[bool]) -> Fr {
        let mut cur = leaf;
        for (sib, bit) in siblings.iter().zip(bits.iter()) {
            cur = if *bit {
                structural_parent(*sib, cur)
            } else {
                structural_parent(cur, *sib)
            };
        }
        cur
    }

    #[test]
    fn index_bits_match_native_convention() {
        // index = 0b101 = 5 → bits LSB-first: 1,0,1
        let bits = index_to_direction_bits(5, 3);
        assert_eq!(bits, vec![true, false, true]);
    }

    #[test]
    fn direction_bits_bound_to_index_accepts_honest() {
        let cs = ConstraintSystem::<Fr>::new_ref();
        let index_val = Fr::from(5u64);
        let index = FpVar::new_witness(cs.clone(), || Ok(index_val)).unwrap();
        let native = index_to_direction_bits(5, 3);
        let bits = allocate_direction_bits(cs.clone(), &index, 3, Some(&native)).unwrap();
        assert!(cs.is_satisfied().unwrap());
        assert_eq!(bits.len(), 3);
    }

    #[test]
    fn direction_bits_reject_flipped_bit() {
        let cs = ConstraintSystem::<Fr>::new_ref();
        let index_val = Fr::from(5u64); // bits 1,0,1
        let index = FpVar::new_witness(cs.clone(), || Ok(index_val)).unwrap();
        // Flip first bit → would reconstruct as 4, not 5
        let mut bad = index_to_direction_bits(5, 3);
        bad[0] = !bad[0];
        let _ = allocate_direction_bits(cs.clone(), &index, 3, Some(&bad));
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn membership_honest_path_with_structural_hash() {
        // Build a depth-3 path manually.
        let leaf = Fr::from(10u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let index: u64 = 0b010; // bits: 0,1,0
        let bits = index_to_direction_bits(index, 3);
        let root = structural_root(leaf, &siblings, &bits);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let leaf_v = FpVar::new_witness(cs.clone(), || Ok(leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let root_v = FpVar::new_input(cs.clone(), || Ok(root)).unwrap();
        let sib_v: Vec<_> = siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        enforce_membership::<StructuralTestHash>(
            cs.clone(),
            &root_v,
            &leaf_v,
            &index_v,
            &sib_v,
            Some(&bits),
        )
        .unwrap();
        assert!(cs.is_satisfied().unwrap());
    }

    #[test]
    fn membership_rejects_wrong_direction_bit() {
        let leaf = Fr::from(10u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let index: u64 = 0b010;
        let bits = index_to_direction_bits(index, 3);
        let root = structural_root(leaf, &siblings, &bits);

        // Prover claims same index but we will force wrong bit via native_bits
        // that don't match index — allocate_direction_bits must fail satisfaction.
        let mut bad_bits = bits.clone();
        bad_bits[1] = !bad_bits[1];

        let cs = ConstraintSystem::<Fr>::new_ref();
        let leaf_v = FpVar::new_witness(cs.clone(), || Ok(leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let root_v = FpVar::new_input(cs.clone(), || Ok(root)).unwrap();
        let sib_v: Vec<_> = siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        let _ = enforce_membership::<StructuralTestHash>(
            cs.clone(),
            &root_v,
            &leaf_v,
            &index_v,
            &sib_v,
            Some(&bad_bits),
        );
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn membership_rejects_altered_sibling() {
        let leaf = Fr::from(10u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let index: u64 = 0b010;
        let bits = index_to_direction_bits(index, 3);
        let root = structural_root(leaf, &siblings, &bits);

        let mut bad_siblings = siblings.clone();
        bad_siblings[0] = Fr::from(99u64);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let leaf_v = FpVar::new_witness(cs.clone(), || Ok(leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let root_v = FpVar::new_input(cs.clone(), || Ok(root)).unwrap();
        let sib_v: Vec<_> = bad_siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        let _ = enforce_membership::<StructuralTestHash>(
            cs.clone(),
            &root_v,
            &leaf_v,
            &index_v,
            &sib_v,
            Some(&bits),
        );
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn update_same_path_old_and_new() {
        let old_leaf = Fr::from(10u64);
        let new_leaf = Fr::from(20u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64), Fr::from(3u64)];
        let index: u64 = 0b101;
        let bits = index_to_direction_bits(index, 3);
        let old_root = structural_root(old_leaf, &siblings, &bits);
        let new_root = structural_root(new_leaf, &siblings, &bits);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let old_leaf_v = FpVar::new_witness(cs.clone(), || Ok(old_leaf)).unwrap();
        let new_leaf_v = FpVar::new_witness(cs.clone(), || Ok(new_leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let old_root_v = FpVar::new_input(cs.clone(), || Ok(old_root)).unwrap();
        let new_root_v = FpVar::new_input(cs.clone(), || Ok(new_root)).unwrap();
        let sib_v: Vec<_> = siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        enforce_update::<StructuralTestHash>(
            cs.clone(),
            &old_root_v,
            &new_root_v,
            &old_leaf_v,
            &new_leaf_v,
            &index_v,
            &sib_v,
            Some(&bits),
        )
        .unwrap();
        assert!(cs.is_satisfied().unwrap());
    }

    #[test]
    fn nullifier_insert_requires_empty_old() {
        let nullifier_leaf = Fr::from(77u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64)];
        let index: u64 = 0b01;
        let bits = index_to_direction_bits(index, 2);
        let empty = Fr::from(EMPTY_LEAF);
        let old_root = structural_root(empty, &siblings, &bits);
        let new_root = structural_root(nullifier_leaf, &siblings, &bits);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let nf_v = FpVar::new_witness(cs.clone(), || Ok(nullifier_leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let old_root_v = FpVar::new_input(cs.clone(), || Ok(old_root)).unwrap();
        let new_root_v = FpVar::new_input(cs.clone(), || Ok(new_root)).unwrap();
        let sib_v: Vec<_> = siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        enforce_nullifier_insert::<StructuralTestHash>(
            cs.clone(),
            &old_root_v,
            &new_root_v,
            &nf_v,
            &index_v,
            &sib_v,
            Some(&bits),
        )
        .unwrap();
        assert!(cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_membership_matches_native() {
        // Depth 2 with real Poseidon — more constraints, still fast.
        let leaf = Fr::from(10u64);
        let siblings = vec![Fr::from(1u64), Fr::from(2u64)];
        let index: u64 = 0b10;
        let bits = index_to_direction_bits(index, 2);
        let path = MerklePathNative {
            siblings: siblings.clone(),
            index_bits: bits.clone(),
        };
        let root = root_from_path_native(leaf, &path);

        let cs = ConstraintSystem::<Fr>::new_ref();
        let leaf_v = FpVar::new_witness(cs.clone(), || Ok(leaf)).unwrap();
        let index_v = FpVar::new_witness(cs.clone(), || Ok(Fr::from(index))).unwrap();
        let root_v = FpVar::new_input(cs.clone(), || Ok(root)).unwrap();
        let sib_v: Vec<_> = siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();

        enforce_membership::<UepPoseidon>(
            cs.clone(),
            &root_v,
            &leaf_v,
            &index_v,
            &sib_v,
            Some(&bits),
        )
        .unwrap();
        assert!(cs.is_satisfied().unwrap());
        assert!(cs.num_constraints() > 200);
    }
}
