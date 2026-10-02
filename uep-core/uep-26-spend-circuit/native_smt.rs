//! Native sparse Merkle tree for test fixtures (Poseidon or structural).

use ark_bn254::Fr;
use std::collections::HashMap;

use crate::hash_gadget::{h_merkle, Hash2, StructuralTestHash, UepPoseidon};

#[derive(Clone)]
pub struct NativeSmt<H: Hash2, const D: usize> {
    nodes: HashMap<(usize, u64), Fr>,
    empty: Vec<Fr>,
    _h: std::marker::PhantomData<H>,
}

impl<H: Hash2, const D: usize> NativeSmt<H, D> {
    pub fn new() -> Self {
        let mut empty = vec![Fr::from(0u64); D + 1];
        for i in 0..D {
            empty[i + 1] = h_merkle::<H>(empty[i], empty[i]);
        }
        Self {
            nodes: HashMap::new(),
            empty,
            _h: std::marker::PhantomData,
        }
    }

    fn get(&self, level: usize, index: u64) -> Fr {
        self.nodes
            .get(&(level, index))
            .copied()
            .unwrap_or(self.empty[level])
    }

    fn set_node(&mut self, level: usize, index: u64, value: Fr) {
        if value == self.empty[level] {
            self.nodes.remove(&(level, index));
        } else {
            self.nodes.insert((level, index), value);
        }
    }

    pub fn root(&self) -> Fr {
        self.get(D, 0)
    }

    pub fn get_leaf(&self, index: u64) -> Fr {
        let mask = if D >= 64 { u64::MAX } else { (1u64 << D) - 1 };
        self.get(0, index & mask)
    }

    pub fn set(&mut self, index: u64, leaf: Fr) {
        let mask = if D >= 64 {
            u64::MAX
        } else {
            (1u64 << D) - 1
        };
        let mut idx = index & mask;
        self.set_node(0, idx, leaf);
        for level in 0..D {
            let sibling_idx = idx ^ 1;
            let left = if idx & 1 == 0 {
                self.get(level, idx)
            } else {
                self.get(level, sibling_idx)
            };
            let right = if idx & 1 == 0 {
                self.get(level, sibling_idx)
            } else {
                self.get(level, idx)
            };
            idx >>= 1;
            self.set_node(level + 1, idx, h_merkle::<H>(left, right));
        }
    }

    pub fn path(&self, index: u64) -> (Vec<Fr>, Vec<bool>) {
        let mask = if D >= 64 {
            u64::MAX
        } else {
            (1u64 << D) - 1
        };
        let mut idx = index & mask;
        let mut siblings = Vec::with_capacity(D);
        let mut bits = Vec::with_capacity(D);
        for level in 0..D {
            let bit = (idx & 1) == 1;
            bits.push(bit);
            siblings.push(self.get(level, idx ^ 1));
            idx >>= 1;
        }
        (siblings, bits)
    }
}

pub type PoseidonSmt<const D: usize> = NativeSmt<UepPoseidon, D>;
pub type StructuralSmt<const D: usize> = NativeSmt<StructuralTestHash, D>;
