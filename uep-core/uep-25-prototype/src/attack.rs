use ark_bn254::Fr;
use crate::{
    fee::creator_fee,
    hash::{h, Domain},
    nullifier::{derive, NullifierSet},
    transition::{transition, State},
};

pub fn attack_inflation() -> bool {
    let old = State { sender: 100_000, recipient: 0, treasury: 0 };
    let valid = transition(old, 10_000).unwrap();
    let honest_total = old.sender as u128 + old.recipient as u128 + old.treasury as u128;
    let new_total = valid.new.sender as u128 + valid.new.recipient as u128 + valid.new.treasury as u128;
    honest_total == new_total
}

pub fn attack_fee_bypass() -> bool {
    creator_fee(100_000) == 100
}

pub fn attack_nullifier_replay() -> bool {
    let mut set = NullifierSet::default();
    let n = derive(Fr::from(7u64), Fr::from(9u64));
    let first = set.insert_once(n);
    let second = set.insert_once(n);
    first && !second
}

pub fn attack_wrong_owner() -> bool {
    let real = h(Domain::Account, Fr::from(7u64), Fr::from(11u64));
    let forged = h(Domain::Account, Fr::from(8u64), Fr::from(11u64));
    real != forged
}
