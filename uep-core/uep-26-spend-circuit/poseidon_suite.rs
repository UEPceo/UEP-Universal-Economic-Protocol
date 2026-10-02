//! Poseidon adversarial suite + constraint counts (UEP-26.8).
//! Included from spend_circuit tests via path — actually standalone test module in lib.

use ark_bn254::Fr;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};

use crate::hash_gadget::{
    h_account, h_nullifier, note_commitment, note_nonce, tx_commitment, UepPoseidon,
};
use crate::native_smt::PoseidonSmt;
use crate::spend_circuit::SpendCircuit;
use crate::smt_gadget::low_bits_u64;
use crate::expected_fee;

fn to_arr<const D: usize>(v: &[Fr]) -> [Fr; D] {
    let mut a = [Fr::from(0u64); D];
    a.copy_from_slice(&v[..D]);
    a
}
fn to_bits<const D: usize>(v: &[bool]) -> [bool; D] {
    let mut a = [false; D];
    a.copy_from_slice(&v[..D]);
    a
}

pub fn honest_spend_fixture_poseidon<const D: usize>(
    amount: u64,
    sender_old_bal: u64,
) -> SpendCircuit<D> {
    let fee = expected_fee(amount);
    let secret = Fr::from(42u64);
    let salt = Fr::from(7u64);
    let sender_id = h_account::<UepPoseidon>(secret, salt);
    let recipient_id = Fr::from(99u64);
    let treasury_id = Fr::from(100u64);
    let asset = Fr::from(1u64);
    let s_blind = Fr::from(3u64);
    let r_blind = Fr::from(4u64);
    let t_blind = Fr::from(5u64);

    let sender_old_amount = Fr::from(sender_old_bal);
    let sender_new_amount = Fr::from(sender_old_bal - amount - fee);
    let amount_fr = Fr::from(amount);
    let fee_fr = Fr::from(fee);
    let recipient_old_amount = Fr::from(0u64);
    let recipient_new_amount = amount_fr;
    let treasury_old_amount = Fr::from(0u64);
    let treasury_new_amount = fee_fr;

    let s_old = note_commitment::<UepPoseidon>(sender_id, asset, sender_old_amount, s_blind);
    let s_new = note_commitment::<UepPoseidon>(sender_id, asset, sender_new_amount, s_blind);
    let r_old = note_commitment::<UepPoseidon>(recipient_id, asset, recipient_old_amount, r_blind);
    let r_new = note_commitment::<UepPoseidon>(recipient_id, asset, recipient_new_amount, r_blind);
    let t_old = note_commitment::<UepPoseidon>(treasury_id, asset, treasury_old_amount, t_blind);
    let t_new = note_commitment::<UepPoseidon>(treasury_id, asset, treasury_new_amount, t_blind);

    let nonce = note_nonce::<UepPoseidon>(s_old, s_blind);
    let nullifier = h_nullifier::<UepPoseidon>(secret, nonce);

    let s_idx = low_bits_u64(sender_id, D);
    let r_idx = low_bits_u64(recipient_id, D);
    let t_idx = low_bits_u64(treasury_id, D);
    let nf_idx = low_bits_u64(nullifier, D);
    assert!(
        s_idx != r_idx && r_idx != t_idx && s_idx != t_idx,
        "canonical index collision in poseidon fixture"
    );

    let mut state = PoseidonSmt::<D>::new();
    state.set(s_idx, s_old);
    state.set(r_idx, r_old);
    state.set(t_idx, t_old);
    let old_state_root = state.root();

    let (s_sibs_v, s_bits_v) = state.path(s_idx);
    state.set(s_idx, s_new);
    let mid1 = state.root();
    let (r_sibs_v, r_bits_v) = state.path(r_idx);
    state.set(r_idx, r_new);
    let mid2 = state.root();
    let (t_sibs_v, t_bits_v) = state.path(t_idx);
    state.set(t_idx, t_new);
    let new_state_root = state.root();

    let mut nf_tree = PoseidonSmt::<D>::new();
    let old_nf_root = nf_tree.root();
    let (nf_sibs_v, nf_bits_v) = nf_tree.path(nf_idx);
    nf_tree.set(nf_idx, nullifier);
    let new_nf_root = nf_tree.root();

    let domain_fr = Fr::from(1u64);
    let transaction_commitment = tx_commitment::<UepPoseidon>(
        old_state_root,
        new_state_root,
        old_nf_root,
        new_nf_root,
        sender_id,
        recipient_id,
        treasury_id,
        asset,
        amount_fr,
        fee_fr,
        nullifier,
        domain_fr,
    );

    SpendCircuit {
        old_state_root,
        new_state_root,
        old_nullifier_root: old_nf_root,
        new_nullifier_root: new_nf_root,
        sender_id,
        recipient_id,
        treasury_id,
        asset_id: asset,
        amount: amount_fr,
        fee: fee_fr,
        nullifier,
        domain_id: domain_fr,
        transaction_commitment,
        sender_secret: secret,
        sender_salt: salt,
        note_blinding: s_blind,
        note_nonce: nonce,
        sender_old_amount,
        sender_new_amount,
        recipient_old_amount,
        recipient_new_amount,
        treasury_old_amount,
        treasury_new_amount,
        mid_root_after_sender: mid1,
        mid_root_after_recipient: mid2,
        sender_index: s_idx,
        sender_siblings: to_arr(&s_sibs_v),
        sender_index_bits: to_bits(&s_bits_v),
        sender_old_leaf: s_old,
        sender_new_leaf: s_new,
        recipient_index: r_idx,
        recipient_siblings: to_arr(&r_sibs_v),
        recipient_index_bits: to_bits(&r_bits_v),
        recipient_old_leaf: r_old,
        recipient_new_leaf: r_new,
        recipient_blinding: r_blind,
        treasury_index: t_idx,
        treasury_siblings: to_arr(&t_sibs_v),
        treasury_index_bits: to_bits(&t_bits_v),
        treasury_old_leaf: t_old,
        treasury_new_leaf: t_new,
        treasury_blinding: t_blind,
        nullifier_index: nf_idx,
        nullifier_siblings: to_arr(&nf_sibs_v),
        nullifier_index_bits: to_bits(&nf_bits_v),
        nullifier_leaf: nullifier,
        use_poseidon: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSynthesizer;

    #[test]
    fn poseidon_d4_honest_accepted() {
        let c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        println!("Poseidon D=4 constraints: {}", cs.num_constraints());
    }

    #[test]
    fn poseidon_d4_c1_wrong_secret() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.sender_secret = Fr::from(99u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_c3_bad_direction_bit() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.sender_index_bits[0] = !c.sender_index_bits[0];
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_c3_bad_sibling() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.recipient_siblings[0] = c.recipient_siblings[0] + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_c7_bad_commitment() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.transaction_commitment = c.transaction_commitment + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_c8_nullifier_reuse() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.old_nullifier_root = c.new_nullifier_root;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d8_honest_and_count() {
        let c = honest_spend_fixture_poseidon::<8>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        let n = cs.num_constraints();
        println!("Poseidon D=8 constraints: {}", n);
        assert!(n > 1_000);
    }

    #[test]
    fn poseidon_d16_honest_and_count() {
        let c = honest_spend_fixture_poseidon::<16>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        let n = cs.num_constraints();
        println!("Poseidon D=16 constraints: {}", n);
        assert!(n > 5_000);
    }

    #[test]
    fn poseidon_d32_honest_and_count() {
        let c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        let n = cs.num_constraints();
        println!("Poseidon D=32 constraints: {}", n);
        assert_eq!(n, 153_098);
    }

    #[test]
    fn poseidon_d32_c3_direction_bit_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.sender_index_bits[15] = !c.sender_index_bits[15];
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_c7_commitment_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.transaction_commitment = Fr::from(0u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_wrong_note_nonce_rejected() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.note_nonce = c.note_nonce + Fr::from(1u64);
        // nullifier derivation will also break; binding of nonce to leaf is what we care about
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_wrong_nullifier_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.nullifier_index = c.nullifier_index ^ 1;
        // bits must match flipped index for path to be consistent attempt
        if !c.nullifier_index_bits.is_empty() {
            c.nullifier_index_bits[0] = !c.nullifier_index_bits[0];
        }
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_wrong_sender_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.sender_index = c.sender_index ^ 1;
        c.sender_index_bits[0] = !c.sender_index_bits[0];
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_note_nonce_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.note_nonce = Fr::from(0u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_nullifier_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.nullifier_index = c.nullifier_index.wrapping_add(1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_constraint_count_regression() {
        let c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap());
        let n = cs.num_constraints();
        println!("Poseidon D=32 constraints (post-binding): {}", n);
        // Exact freeze: update if intentionally changed after binding hardening
        // First run may differ from pre-binding 149491 — assert and print.
        assert_eq!(n, 153_098, "D=32 constraint count regression: expected 153098, got {n}");
    }

    // ---- UEP-26.10 adversarial hardening ----

    #[test]
    fn poseidon_d32_wrong_recipient_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.recipient_index = c.recipient_index.wrapping_add(1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_treasury_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.treasury_index = c.treasury_index.wrapping_add(1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_sender_index_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.sender_index = c.sender_index.wrapping_add(1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_combined_wrong_nonce_and_nullifier() {
        // Alternate nonce + recomputed nullifier still fails leaf binding
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.note_nonce = c.note_nonce + Fr::from(7u64);
        // Leave public nullifier as original — derivation fails
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_combined_wrong_index_and_siblings() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.nullifier_index = c.nullifier_index.wrapping_add(1);
        c.nullifier_siblings[0] = c.nullifier_siblings[0] + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_combined_wrong_recipient_index_and_bits() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.recipient_index = c.recipient_index ^ 1;
        c.recipient_index_bits[0] = !c.recipient_index_bits[0];
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_combined_wrong_treasury_index_and_root() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.treasury_index = c.treasury_index.wrapping_add(1);
        c.new_state_root = c.new_state_root + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_combined_wrong_leaf_matching_amount() {
        // Tamper sender_old_leaf while keeping amount — leaf binding must fail
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.sender_old_leaf = c.sender_old_leaf + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_wrong_salt_rejected() {
        let mut c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        c.sender_salt = c.sender_salt + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_fee_minus_one_rejected() {
        use crate::expected_fee;
        let mut c = honest_spend_fixture_poseidon::<4>(1_000_000, 2_000_000);
        let fee = expected_fee(1_000_000);
        assert!(fee > 0);
        c.fee = Fr::from(fee - 1);
        c.sender_new_amount = Fr::from(2_000_000u64 - 1_000_000 - (fee - 1));
        c.treasury_new_amount = Fr::from(fee - 1);
        // Roots/commitment will also be inconsistent; circuit must reject
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d4_fee_plus_one_rejected() {
        use crate::expected_fee;
        let mut c = honest_spend_fixture_poseidon::<4>(1_000_000, 2_000_000);
        let fee = expected_fee(1_000_000);
        c.fee = Fr::from(fee + 1);
        c.sender_new_amount = Fr::from(2_000_000u64 - 1_000_000 - (fee + 1));
        c.treasury_new_amount = Fr::from(fee + 1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_combined_wrong_nonce_and_index() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.note_nonce = c.note_nonce + Fr::from(1u64);
        c.nullifier_index = c.nullifier_index.wrapping_add(1);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_sender_sibling_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.sender_siblings[0] = c.sender_siblings[0] + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn poseidon_d32_wrong_nullifier_sibling_rejected() {
        let mut c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        c.nullifier_siblings[7] = c.nullifier_siblings[7] + Fr::from(3u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }
}
