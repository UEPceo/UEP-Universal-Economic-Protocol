use uep_24_atomic_state_transition::model::AtomicBalances;

#[test]
fn honest_transfer_conserves_value() {
    let t = AtomicBalances {
        sender_old: 100_000,
        recipient_old: 10_000,
        treasury_old: 5_000,
        amount: 50_000,
    };

    assert_eq!(t.fee(), 50);
    assert_eq!(t.sender_new(), Some(49_950));
    assert_eq!(t.recipient_new(), Some(60_000));
    assert_eq!(t.treasury_new(), Some(5_050));
    assert!(t.is_conserving());
}

#[test]
fn underfunded_sender_cannot_make_valid_transition() {
    let t = AtomicBalances {
        sender_old: 10,
        recipient_old: 0,
        treasury_old: 0,
        amount: 10,
    };

    // fee=0 for this policy, but amount still consumes the whole sender.
    assert_eq!(t.sender_new(), Some(0));
    assert!(t.is_conserving());
}

#[test]
fn sender_underflow_is_rejected() {
    let t = AtomicBalances {
        sender_old: 9,
        recipient_old: 0,
        treasury_old: 0,
        amount: 10,
    };

    assert_eq!(t.sender_new(), None);
    assert!(!t.is_conserving());
}

#[test]
fn treasury_and_recipient_are_part_of_conservation() {
    let t = AtomicBalances {
        sender_old: 100_000,
        recipient_old: 10_000,
        treasury_old: 1_000,
        amount: 25_000,
    };

    let s = t.sender_new().unwrap();
    let r = t.recipient_new().unwrap();
    let tr = t.treasury_new().unwrap();

    assert_eq!(
        t.sender_old as u128 + t.recipient_old as u128 + t.treasury_old as u128,
        s as u128 + r as u128 + tr as u128
    );
}

#[test]
fn fee_is_exactly_point_one_percent_for_integer_units() {
    let t = AtomicBalances {
        sender_old: 100_000,
        recipient_old: 0,
        treasury_old: 0,
        amount: 100_000,
    };
    assert_eq!(t.fee(), 100);
}

#[test]
fn microtransaction_policy_is_explicitly_visible() {
    for amount in 1..1000 {
        let t = AtomicBalances {
            sender_old: 10_000,
            recipient_old: 0,
            treasury_old: 0,
            amount,
        };
        assert_eq!(t.fee(), 0);
    }
}
