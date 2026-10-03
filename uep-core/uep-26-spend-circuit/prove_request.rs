//! Wallet → Poseidon spend request (UEP-28.6).
//!
//! The wallet sends economic fields; Rust builds Poseidon SMT + SpendCircuit
//! so public inputs are cryptographically bound to the real spend (not a fixture mismatch).

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use serde::{Deserialize, Serialize};
use crate::hash_gadget::{
    h_account, h_nullifier, note_commitment, note_nonce, tx_commitment, UepPoseidon,
};
use crate::native_smt::PoseidonSmt;
use crate::smt_gadget::{low_bits_u64, state_index};
use crate::spend_circuit::SpendCircuit;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoseidonSpendRequest {
    /// SMT depth: 4 (fast) or 32 (production circuit).
    #[serde(default = "default_depth")]
    pub depth: u32,
    #[serde(default = "default_seed")]
    pub seed: u64,
    /// Decimal or 0x-hex field elements / integers.
    pub sender_secret: String,
    pub sender_salt: String,
    pub recipient_id: String,
    pub treasury_id: String,
    pub asset_id: String,
    #[serde(deserialize_with = "de_u64_flex")]
    pub amount: u64,
    #[serde(deserialize_with = "de_u64_flex")]
    pub fee: u64,
    /// Public domain number. Lab profile uses 1.
    #[serde(default = "default_domain")]
    pub domain_id: u64,
    #[serde(deserialize_with = "de_u64_flex")]
    pub sender_old_balance: u64,
    #[serde(default, deserialize_with = "de_u64_flex_opt")]
    pub recipient_old_balance: u64,
    #[serde(default, deserialize_with = "de_u64_flex_opt")]
    pub treasury_old_balance: u64,
    pub note_blinding: String,
    pub recipient_blinding: String,
    pub treasury_blinding: String,
    /// Additional state leaves as ["index", "leaf_hex"] pairs for multi-leaf canonical state.
    /// Sender/recipient/treasury leaves are always applied on top.
    #[serde(default)]
    pub extra_state_leaves: Vec<(u64, String)>,
    /// Prior nullifiers already in the nullifier SMT (hex Fr values).
    #[serde(default)]
    pub existing_nullifiers: Vec<String>,
    /// Network profile label: "dev" | "testnet" | "local". Stored for DEV isolation checks.
    #[serde(default = "default_network_profile")]
    pub network_profile: String,
    /// If set, circuit old_state_root must match (canonical chain).
    #[serde(default)]
    pub expected_old_state_root: Option<String>,
    #[serde(default)]
    pub expected_old_nullifier_root: Option<String>,
}

fn default_network_profile() -> String {
    "dev".into()
}

fn default_domain() -> u64 { 1 }
fn default_depth() -> u32 {
    4
}
fn default_seed() -> u64 {
    42
}

fn de_u64_flex<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    use serde::de::{self, Visitor};
    use std::fmt;
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = u64;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("u64 or decimal string")
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<u64, E> { Ok(v) }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<u64, E> {
            if v < 0 { return Err(E::custom("negative")); }
            Ok(v as u64)
        }
        fn visit_str<E: de::Error>(self, s: &str) -> Result<u64, E> {
            s.parse().map_err(E::custom)
        }
    }
    d.deserialize_any(V)
}

fn de_u64_flex_opt<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    de_u64_flex(d)
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoseidonSpendResponse {
    pub ok: bool,
    pub depth: u32,
    pub vk_hex: String,
    pub proof_hex: String,
    pub vk_id: String,
    pub public_inputs_hex: Vec<String>,
    pub public_input_names: Vec<String>,
    /// Echo of bound economic public fields (hex).
    pub sender_id: String,
    pub recipient_id: String,
    pub treasury_id: String,
    pub asset_id: String,
    pub amount: String,
    pub fee: String,
    pub nullifier: String,
    pub transaction_commitment: String,
    pub old_state_root: String,
    pub new_state_root: String,
    pub error: Option<String>,
}

/// Big-endian bytes (exactly 32) to a field element, rejecting values >= p (V47-08).
pub fn fr_from_be32_canonical(bytes: &[u8]) -> Result<Fr, String> {
    if bytes.len() != 32 {
        return Err("field element must be 32 bytes".into());
    }
    let f = Fr::from_be_bytes_mod_order(bytes);
    if f.into_repr().to_bytes_be() != bytes {
        return Err("NON_CANONICAL_FIELD: value is not below the BN254 scalar modulus".into());
    }
    Ok(f)
}

/// Hex (with or without 0x, at most 32 bytes) to a canonical field element.
pub fn parse_canonical_fr_hex(s: &str) -> Result<Fr, String> {
    let s = s.trim();
    let body = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    let mut bytes = hex::decode(body).map_err(|e| e.to_string())?;
    if bytes.len() > 32 {
        return Err("fr hex too long".into());
    }
    while bytes.len() < 32 {
        bytes.insert(0, 0);
    }
    fr_from_be32_canonical(&bytes)
}

/// Decimal string of any length to a canonical field element (no truncation, V47-08).
pub fn parse_canonical_fr_dec(s: &str) -> Result<Fr, String> {
    let s = s.trim();
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err("parse int: invalid decimal".into());
    }
    // Base-10 to base-256, big-endian.
    let mut out: Vec<u8> = vec![0];
    for c in s.bytes() {
        let mut carry = (c - b'0') as u32;
        for b in out.iter_mut().rev() {
            let v = (*b as u32) * 10 + carry;
            *b = (v & 0xff) as u8;
            carry = v >> 8;
        }
        while carry > 0 {
            out.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
        if out.len() > 33 {
            return Err("decimal value too large for a field element".into());
        }
    }
    while out.len() > 1 && out[0] == 0 {
        out.remove(0);
    }
    if out.len() > 32 {
        return Err("decimal value too large for a field element".into());
    }
    while out.len() < 32 {
        out.insert(0, 0);
    }
    fr_from_be32_canonical(&out)
}

/// Decimal or hex (0x-prefixed, or bare hex of at least 32 digits) to a canonical field element.
pub fn parse_canonical_fr(s: &str) -> Result<Fr, String> {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") || (s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit())) {
        return parse_canonical_fr_hex(s);
    }
    parse_canonical_fr_dec(s)
}

fn parse_fr(s: &str) -> Result<Fr, String> {
    parse_canonical_fr(s)
}

pub fn fr_hex(f: &Fr) -> String {
    let bytes = f.into_repr().to_bytes_be();
    format!("0x{}", hex::encode(bytes))
}

fn to_arr<const D: usize>(v: &[Fr]) -> [Fr; D] {
    let mut a = [Fr::from(0u64); D];
    for (i, x) in v.iter().enumerate().take(D) {
        a[i] = *x;
    }
    a
}

fn to_bits<const D: usize>(v: &[bool]) -> [bool; D] {
    let mut a = [false; D];
    for (i, x) in v.iter().enumerate().take(D) {
        a[i] = *x;
    }
    a
}

/// Build Poseidon SpendCircuit from wallet economic request (depth fixed at compile time).
pub fn circuit_from_request<const D: usize>(req: &PoseidonSpendRequest) -> Result<SpendCircuit<D>, String> {
    if req.amount as u128 + req.fee as u128 > req.sender_old_balance as u128 {
        return Err("insufficient sender_old_balance for amount+fee".into());
    }
    let secret = parse_fr(&req.sender_secret)?;
    let salt = parse_fr(&req.sender_salt)?;
    let sender_id = h_account::<UepPoseidon>(secret, salt);
    let recipient_id = parse_fr(&req.recipient_id)?;
    let treasury_id = parse_fr(&req.treasury_id)?;
    let asset = parse_fr(&req.asset_id)?;
    let s_blind = parse_fr(&req.note_blinding)?;
    let r_blind = parse_fr(&req.recipient_blinding)?;
    let t_blind = parse_fr(&req.treasury_blinding)?;

    let amount_fr = Fr::from(req.amount);
    let fee_fr = Fr::from(req.fee);
    let sender_old_amount = Fr::from(req.sender_old_balance);
    let sender_new_amount = Fr::from(req.sender_old_balance - req.amount - req.fee);
    let recipient_old_amount = Fr::from(req.recipient_old_balance);
    let recipient_new_amount = Fr::from(
        req.recipient_old_balance
            .checked_add(req.amount)
            .ok_or("AMOUNT_OVERFLOW: recipient balance exceeds u64")?,
    );
    let treasury_old_amount = Fr::from(req.treasury_old_balance);
    let treasury_new_amount = Fr::from(
        req.treasury_old_balance
            .checked_add(req.fee)
            .ok_or("AMOUNT_OVERFLOW: treasury balance exceeds u64")?,
    );

    let s_old = note_commitment::<UepPoseidon>(sender_id, asset, sender_old_amount, s_blind);
    let s_new = note_commitment::<UepPoseidon>(sender_id, asset, sender_new_amount, s_blind);
    let r_old = note_commitment::<UepPoseidon>(recipient_id, asset, recipient_old_amount, r_blind);
    let r_new = note_commitment::<UepPoseidon>(recipient_id, asset, recipient_new_amount, r_blind);
    let t_old = note_commitment::<UepPoseidon>(treasury_id, asset, treasury_old_amount, t_blind);
    let t_new = note_commitment::<UepPoseidon>(treasury_id, asset, treasury_new_amount, t_blind);

    let nonce = note_nonce::<UepPoseidon>(s_old, s_blind);
    let nullifier = h_nullifier::<UepPoseidon>(secret, nonce);

    // V47-02: one leaf per (account, asset): index = lowBits(H_ACCOUNT(id, asset), D).
    let s_idx = state_index::<UepPoseidon>(sender_id, asset, D);
    let r_idx = state_index::<UepPoseidon>(recipient_id, asset, D);
    let t_idx = state_index::<UepPoseidon>(treasury_id, asset, D);
    let nf_idx = low_bits_u64(nullifier, D);
    if s_idx == r_idx || r_idx == t_idx || s_idx == t_idx {
        return Err("SMT_INDEX_COLLISION: sender/recipient/treasury map to the same state slot".into());
    }

    // Canonical multi-leaf Poseidon state: extra leaves first, then spend parties.
    let mut pre: Vec<(u64, Fr)> = Vec::new();
    for (idx, leaf_s) in &req.extra_state_leaves {
        pre.push((*idx, parse_fr(leaf_s)?));
    }
    // A spend party's slot must be empty or hold that party's own old leaf:
    // another (account, asset) leaf at the same truncated index is a collision.
    for (idx, leaf) in &pre {
        for (party_idx, party_old) in [(s_idx, s_old), (r_idx, r_old), (t_idx, t_old)] {
            if *idx == party_idx && *leaf != party_old {
                return Err("SMT_INDEX_COLLISION: a state slot of this spend holds another leaf".into());
            }
        }
    }
    pre.push((s_idx, s_old));
    pre.push((r_idx, r_old));
    pre.push((t_idx, t_old));
    let mut state = crate::canonical_state::build_state_from_leaves::<D>(&pre);
    let old_state_root = state.root();
    if let Some(ref exp) = req.expected_old_state_root {
        let e = parse_fr(exp)?;
        if e != old_state_root {
            return Err("STALE_ROOT: old_state_root mismatch vs expected_old_state_root".into());
        }
    }

    let (s_sibs_v, s_bits_v) = state.path(s_idx);
    state.set(s_idx, s_new);
    let mid1 = state.root();
    let (r_sibs_v, r_bits_v) = state.path(r_idx);
    state.set(r_idx, r_new);
    let mid2 = state.root();
    let (t_sibs_v, t_bits_v) = state.path(t_idx);
    state.set(t_idx, t_new);
    let new_state_root = state.root();

    // Nullifier SMT: seed existing, then insert new (reject if slot occupied by other value).
    let mut nf_pre: Vec<(u64, Fr)> = Vec::new();
    for ns in &req.existing_nullifiers {
        let n = parse_fr(ns)?;
        let i = crate::smt_gadget::low_bits_u64(n, D);
        nf_pre.push((i, n));
    }
    let mut nf_tree = crate::canonical_state::build_state_from_leaves::<D>(&nf_pre);
    let existing_leaf = nf_tree.get_leaf(nf_idx);
    let empty = Fr::from(0u64);
    if existing_leaf != empty && existing_leaf != nullifier {
        return Err("nullifier slot non-empty: double-spend or index collision".into());
    }
    let old_nf_root = nf_tree.root();
    if let Some(ref exp) = req.expected_old_nullifier_root {
        let e = parse_fr(exp)?;
        if e != old_nf_root {
            return Err("STALE_NULLIFIER_ROOT: mismatch vs expected".into());
        }
    }
    let (nf_sibs_v, nf_bits_v) = nf_tree.path(nf_idx);
    nf_tree.set(nf_idx, nullifier);
    let new_nf_root = nf_tree.root();

    let domain_fr = Fr::from(req.domain_id);
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

    Ok(SpendCircuit {
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
    })
}


#[cfg(test)]
mod parse_tests {
    use super::*;

    const P_DEC: &str =
        "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    const P_HEX: &str = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

    #[test]
    fn modulus_and_above_rejected() {
        assert!(parse_canonical_fr(P_DEC).is_err());
        assert!(parse_canonical_fr(P_HEX).is_err());
        assert!(parse_canonical_fr(&format!("{P_DEC}0")).is_err());
        assert!(parse_canonical_fr("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000").is_ok());
    }

    #[test]
    fn wide_decimal_is_not_truncated() {
        // 2^64 must stay 2^64 (it used to be truncated to 64 bits).
        let f = parse_canonical_fr("18446744073709551616").unwrap();
        assert_eq!(f, Fr::from(u64::MAX) + Fr::from(1u64));
        assert_eq!(parse_canonical_fr("42").unwrap(), Fr::from(42u64));
        assert!(parse_canonical_fr("-1").is_err());
        assert!(parse_canonical_fr("").is_err());
    }

    fn base_request() -> PoseidonSpendRequest {
        serde_json::from_str(
            r#"{"sender_secret":"7","sender_salt":"11","recipient_id":"0x1234","treasury_id":"0x5678",
                "asset_id":"1","amount":1000,"fee":1,"sender_old_balance":10000,
                "note_blinding":"3","recipient_blinding":"5","treasury_blinding":"9"}"#,
        )
        .unwrap()
    }

    #[test]
    fn other_leaf_in_party_slot_rejected() {
        let req = base_request();
        let c = circuit_from_request::<32>(&req).unwrap();
        let mut bad = req.clone();
        bad.extra_state_leaves = vec![(c.recipient_index, "0x01".into())];
        let err = circuit_from_request::<32>(&bad).err().expect("must fail");
        assert!(err.contains("SMT_INDEX_COLLISION"), "{err}");
    }

    #[test]
    fn recipient_overflow_rejected() {
        let mut req = base_request();
        req.recipient_old_balance = u64::MAX;
        let err = circuit_from_request::<32>(&req).err().expect("must fail");
        assert!(err.contains("AMOUNT_OVERFLOW"), "{err}");
    }
}
