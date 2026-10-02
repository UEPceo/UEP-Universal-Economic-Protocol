use ark_bn254::Fr;
use crate::hash::{h, Domain};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerklePath<const D: usize> {
    pub siblings: [Fr; D],
    pub index_bits: [bool; D],
}

fn node(left: Fr, right: Fr) -> Fr {
    h(Domain::MerkleNode, left, right)
}

pub fn root_from_path<const D: usize>(
    leaf: Fr,
    path: &MerklePath<D>,
) -> Fr {
    let mut cur = leaf;
    for i in 0..D {
        cur = if path.index_bits[i] {
            node(path.siblings[i], cur)
        } else {
            node(cur, path.siblings[i])
        };
    }
    cur
}

pub fn verify_membership<const D: usize>(
    expected_root: Fr,
    leaf: Fr,
    path: &MerklePath<D>,
) -> bool {
    root_from_path(leaf, path) == expected_root
}

/// A sparse update proof is represented by the old/new leaf plus the same path.
/// The circuit must bind both roots to the exact path.
pub fn verify_update<const D: usize>(
    old_root: Fr,
    new_root: Fr,
    old_leaf: Fr,
    new_leaf: Fr,
    path: &MerklePath<D>,
) -> bool {
    root_from_path(old_leaf, path) == old_root
        && root_from_path(new_leaf, path) == new_root
}

/// For a nullifier tree, an unused leaf is represented by the canonical empty
/// leaf. In production this empty value must be globally frozen and included in
/// the protocol genesis.
pub fn verify_insert<const D: usize>(
    old_root: Fr,
    new_root: Fr,
    empty_leaf: Fr,
    inserted_leaf: Fr,
    path: &MerklePath<D>,
) -> bool {
    verify_update(old_root, new_root, empty_leaf, inserted_leaf, path)
}
