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
use crate::smt_gadget::low_bits_u64;
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

fn parse_fr(s: &str) -> Result<Fr, String> {
    let s = s.trim();
    let hex_body = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .or_else(|| {
            // bare 64-char hex (nullifier/root fingerprints)
            if s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(s)
            } else {
                None
            }
        });
    if let Some(hex) = hex_body {
        let mut bytes = hex::decode(hex).map_err(|e| e.to_string())?;
        if bytes.len() > 32 {
            return Err("fr hex too long".into());
        }
        while bytes.len() < 32 {
            bytes.insert(0, 0);
        }
        return Ok(Fr::from_be_bytes_mod_order(&bytes));
    }
    // decimal
    let n: u128 = s.parse().map_err(|e| format!("parse int: {e}"))?;
    Ok(Fr::from(n as u64))
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
    let recipient_new_amount = Fr::from(req.recipient_old_balance + req.amount);
    let treasury_old_amount = Fr::from(req.treasury_old_balance);
    let treasury_new_amount = Fr::from(req.treasury_old_balance + req.fee);

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
    if s_idx == r_idx || r_idx == t_idx || s_idx == t_idx {
        return Err("canonical index collision among sender/recipient/treasury".into());
    }

    // Canonical multi-leaf Poseidon state: extra leaves first, then spend parties.
    let mut pre: Vec<(u64, Fr)> = Vec::new();
    for (idx, leaf_s) in &req.extra_state_leaves {
        pre.push((*idx, parse_fr(leaf_s)?));
    }
    // Apply spend-related leaves (override any extra at same index)
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

