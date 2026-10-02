use ark_bn254::Fr;
use uep_25_prototype::{
    attack::*,
    fee::creator_fee,
    hash::{h, Domain},
    nullifier::derive,
    transition::{transition, State},
};

#[test]
fn value_cannot_be_created() {
    assert!(attack_inflation());
}

#[test]
fn creator_fee_is_forced_by_transition() {
    assert!(attack_fee_bypass());
    let t = transition(State { sender: 100_100, recipient: 0, treasury: 0 }, 100_000).unwrap();
    assert_eq!(t.fee, 100);
    assert_eq!(t.new.treasury, 100);
}

#[test]
fn replayed_nullifier_is_rejected_by_state_machine() {
    assert!(attack_nullifier_replay());
}

#[test]
fn wrong_secret_does_not_produce_same_account_id() {
    assert!(attack_wrong_owner());
}

#[test]
fn underflow_is_rejected() {
    assert!(transition(State { sender: 99, recipient: 0, treasury: 0 }, 100).is_err());
}

#[test]
fn overflow_is_rejected() {
    assert!(transition(
        State { sender: 10_000, recipient: u64::MAX, treasury: 0 },
        1
    ).is_err());
}

#[test]
fn fee_policy_is_explicit_for_micro_amounts() {
    for amount in 0..1000 {
        assert_eq!(creator_fee(amount), 0);
    }
}

#[test]
fn nullifier_is_deterministic() {
    let a = derive(Fr::from(1u64), Fr::from(2u64));
    let b = derive(Fr::from(1u64), Fr::from(2u64));
    assert_eq!(a, b);
}

#[test]
fn domains_are_separated() {
    let a = h(Domain::Account, Fr::from(1), Fr::from(2));
    let n = h(Domain::Nullifier, Fr::from(1), Fr::from(2));
    assert_ne!(a, n);
}
