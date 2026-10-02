//! UEP-28.11 — Canonical Poseidon state + StateWitness.
//!
//! Contract (frozen for ZK path):
//! - Depth D ∈ {4, 32}; production target D=32
//! - Index = lowBits(key, D) as u64
//! - Empty leaf = Fr(0)
//! - Internal nodes = H_MERKLE(left, right) with UepPoseidon
//! - Root = node at level D index 0
//! - Leaf encoding for balances is note_commitment (owner, asset, amount, blinding)
//! - Nullifier leaf = nullifier value itself at index lowBits(nullifier, D)
//!
//! StateWitness proves membership of one leaf under a root without the full tree.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use serde::{Deserialize, Serialize};

use crate::hash_gadget::{h_merkle, UepPoseidon};
use crate::native_smt::PoseidonSmt;
use crate::smt_gadget::low_bits_u64;

/// One Merkle authentication path under a Poseidon SMT of depth D.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateWitnessJson {
    pub depth: u32,
    pub index: u64,
    pub leaf: String,
    pub root: String,
    pub siblings: Vec<String>,
    /// LSB-first direction bits; must equal index bit i at position i.
    pub index_bits: Vec<bool>,
}

#[derive(Debug, Clone)]
pub struct StateWitness<const D: usize> {
    pub index: u64,
    pub leaf: Fr,
    pub root: Fr,
    pub siblings: [Fr; D],
    pub index_bits: [bool; D],
}

impl<const D: usize> StateWitness<D> {
    pub fn from_tree(tree: &PoseidonSmt<D>, index: u64, leaf: Fr) -> Self {
        let (sibs, bits) = tree.path(index);
        let mut siblings = [Fr::from(0u64); D];
        let mut index_bits = [false; D];
        for i in 0..D {
            siblings[i] = sibs[i];
            index_bits[i] = bits[i];
        }
        Self {
            index,
            leaf,
            root: tree.root(),
            siblings,
            index_bits,
        }
    }

    /// Recompute root from leaf + siblings; must equal self.root if valid.
    pub fn compute_root(&self) -> Fr {
        let mut cur = self.leaf;
        for i in 0..D {
            let sib = self.siblings[i];
            cur = if self.index_bits[i] {
                h_merkle::<UepPoseidon>(sib, cur)
            } else {
                h_merkle::<UepPoseidon>(cur, sib)
            };
        }
        cur
    }

    pub fn verify(&self) -> bool {
        // index bits consistency
        for i in 0..D {
            let bit = ((self.index >> i) & 1) == 1;
            if self.index_bits[i] != bit {
                return false;
            }
        }
        self.compute_root() == self.root
    }

    pub fn to_json(&self) -> StateWitnessJson {
        StateWitnessJson {
            depth: D as u32,
            index: self.index,
            leaf: fr_hex(&self.leaf),
            root: fr_hex(&self.root),
            siblings: self.siblings.iter().map(fr_hex).collect(),
            index_bits: self.index_bits.to_vec(),
        }
    }
}

fn fr_hex(f: &Fr) -> String {
    use ark_ff::{BigInteger, PrimeField};
    format!("0x{}", hex::encode(f.into_repr().to_bytes_be()))
}

pub fn parse_fr_hex(s: &str) -> Result<Fr, String> {
    use ark_ff::PrimeField;
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    let mut bytes = hex::decode(s).map_err(|e| e.to_string())?;
    if bytes.len() > 32 {
        return Err("fr hex too long".into());
    }
    while bytes.len() < 32 {
        bytes.insert(0, 0);
    }
    Ok(Fr::from_be_bytes_mod_order(&bytes))
}

/// Deterministic multi-leaf Poseidon state: same set of (index, leaf) → same root
/// regardless of insertion order (last-write-wins per index).
pub fn build_state_from_leaves<const D: usize>(leaves: &[(u64, Fr)]) -> PoseidonSmt<D> {
    // Sort by index for determinism of iteration; set is order-independent for distinct indices.
    let mut sorted = leaves.to_vec();
    sorted.sort_by_key(|(i, _)| *i);
    // Collapse duplicates: last wins
    let mut map = std::collections::BTreeMap::new();
    for (i, l) in sorted {
        map.insert(i, l);
    }
    let mut tree = PoseidonSmt::<D>::new();
    for (i, l) in map {
        tree.set(i, l);
    }
    tree
}

pub fn index_of_id<const D: usize>(id: Fr) -> u64 {
    low_bits_u64(id, D)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

    #[test]
    fn same_leaves_same_root_independent_of_order() {
        let a = (1u64, Fr::from(10u64));
        let b = (2u64, Fr::from(20u64));
        let c = (5u64, Fr::from(30u64));
        let t1 = build_state_from_leaves::<8>(&[a, b, c]);
        let t2 = build_state_from_leaves::<8>(&[c, a, b]);
        let t3 = build_state_from_leaves::<8>(&[b, c, a]);
        assert_eq!(t1.root(), t2.root());
        assert_eq!(t2.root(), t3.root());
    }

    #[test]
    fn different_leaf_different_root() {
        let t1 = build_state_from_leaves::<8>(&[(1, Fr::from(10u64))]);
        let t2 = build_state_from_leaves::<8>(&[(1, Fr::from(11u64))]);
        assert_ne!(t1.root(), t2.root());
    }

    #[test]
    fn state_witness_verifies() {
        let mut tree = PoseidonSmt::<8>::new();
        let leaf = Fr::from(42u64);
        tree.set(3, leaf);
        let w = StateWitness::<8>::from_tree(&tree, 3, leaf);
        assert!(w.verify());
        assert_eq!(w.root, tree.root());
    }

    #[test]
    fn state_witness_rejects_tampered_sibling() {
        let mut tree = PoseidonSmt::<8>::new();
        let leaf = Fr::from(42u64);
        tree.set(3, leaf);
        let mut w = StateWitness::<8>::from_tree(&tree, 3, leaf);
        w.siblings[0] = Fr::from(99u64);
        assert!(!w.verify());
    }

    #[test]
    fn nullifier_insert_changes_root() {
        let mut nf = PoseidonSmt::<8>::new();
        let old = nf.root();
        let n = Fr::from(12345u64);
        let idx = index_of_id::<8>(n);
        // non-membership: empty
        assert_eq!(nf.path(idx).0.len(), 8);
        nf.set(idx, n);
        assert_ne!(nf.root(), old);
        // re-insert same → same root
        let mid = nf.root();
        nf.set(idx, n);
        assert_eq!(nf.root(), mid);
    }
}
