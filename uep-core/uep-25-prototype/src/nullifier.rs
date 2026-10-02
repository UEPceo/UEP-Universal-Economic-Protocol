use ark_bn254::Fr;
use crate::hash::{h, Domain};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Nullifier {
    pub value: Fr,
}

pub fn derive(secret: Fr, nonce: Fr) -> Nullifier {
    Nullifier { value: h(Domain::Nullifier, secret, nonce) }
}

#[derive(Default, Debug)]
pub struct NullifierSet {
    seen: std::collections::HashSet<String>,
}

impl NullifierSet {
    pub fn insert_once(&mut self, n: Nullifier) -> bool {
        let key = format!("{:?}", n.value);
        self.seen.insert(key)
    }

    pub fn contains(&self, n: Nullifier) -> bool {
        self.seen.contains(&format!("{:?}", n.value))
    }
}
