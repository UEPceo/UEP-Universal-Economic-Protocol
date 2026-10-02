use ark_bn254::Fr;
use ark_ff::PrimeField;

/// Domain-separated hash interface.
///
/// NOTE: This is a deterministic prototype hash interface used to keep the
/// state model self-contained. The production circuit must replace this
/// implementation with one frozen Poseidon/Poseidon2 parameter set and publish
/// its test vectors.
///
/// Domain separation prevents accidental reuse of the same hash relation for
/// account IDs, nullifiers and Merkle nodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Account = 1,
    Nullifier = 2,
    MerkleNode = 3,
    Leaf = 4,
    Transaction = 5,
}

pub fn h(domain: Domain, a: Fr, b: Fr) -> Fr {
    // Deterministic algebraic placeholder for the state-machine prototype.
    // It is NOT claimed to be a production Poseidon permutation.
    let d = Fr::from(domain as u64);
    let x = a + d;
    let y = b + d;
    (x + y) * (x + y) + x * y + d
}
