//! 0.5.83 — spend circuit layout v6: native builder, native predicate, migration helpers.
//!
//! Liveness fix for the spend circuit (internal report UEP-RR-2026-10-15-001):
//! - the sender's new leaf uses a rotated blinding `H(D_BLIND, secret, nonce)`, so a later
//!   spend never reuses an earlier nonce, even when a balance returns to an earlier value;
//! - production depth 64 (was 32) for the state and nullifier trees;
//! - a recipient or treasury slot may start empty (leaf 0, balance 0).
//!
//! `spend_valid` is an independent native statement of what the v6 (and v5) circuit accepts.
//! The differential tests in this module check circuit ⇔ predicate in both directions.

use ark_bn254::Fr;
use ark_ff::PrimeField;

use crate::expected_fee;
use crate::hash_gadget::{
    h_account, h_leaf, h_merkle, h_nullifier, note_commitment, note_nonce, rotate_blinding,
    state_key, tx_commitment, Hash2, StructuralTestHash, UepPoseidon,
};
use crate::native_smt::NativeSmt;
use crate::smt_gadget::{index_to_direction_bits, low_bits_u64, state_index};
use crate::spend_circuit::{SpendCircuit, SpendLayout};

/// Hash backends a spend can be built with (selects the circuit's `use_poseidon` flag).
pub trait SpendHash: Hash2 {
    const POSEIDON: bool;
}
impl SpendHash for UepPoseidon {
    const POSEIDON: bool = true;
}
impl SpendHash for StructuralTestHash {
    const POSEIDON: bool = false;
}

/// A receiving party (recipient or treasury) as seen by the payer.
#[derive(Clone, Debug)]
pub struct Party {
    pub id: Fr,
    /// Blinding of the party's current leaf, or the blinding to open an empty slot with.
    /// The payer must know it (see residual R-BLIND in docs/audit/0.5.83-SPEND-CIRCUIT.md).
    pub blinding: Fr,
    pub old_balance: u64,
}

#[derive(Clone, Debug)]
pub struct SpendParams {
    pub secret: Fr,
    pub salt: Fr,
    /// Blinding of the sender's current leaf.
    pub sender_blinding: Fr,
    pub sender_old_balance: u64,
    pub recipient: Party,
    pub treasury: Party,
    pub asset: Fr,
    pub amount: u64,
    pub domain_id: u64,
}

/// Ledger trees for a spend (state tree keyed by lowBits(H_ACCOUNT(id, asset), D),
/// nullifier tree keyed by lowBits(nullifier, D)).
pub struct SpendTrees<H: Hash2, const D: usize> {
    pub state: NativeSmt<H, D>,
    pub nullifiers: NativeSmt<H, D>,
}

impl<H: Hash2, const D: usize> Clone for SpendTrees<H, D> {
    fn clone(&self) -> Self {
        Self { state: self.state.clone(), nullifiers: self.nullifiers.clone() }
    }
}

impl<H: Hash2, const D: usize> SpendTrees<H, D> {
    pub fn new() -> Self {
        Self { state: NativeSmt::new(), nullifiers: NativeSmt::new() }
    }
}

impl<H: Hash2, const D: usize> Default for SpendTrees<H, D> {
    fn default() -> Self {
        Self::new()
    }
}

fn arr<const D: usize>(v: &[Fr]) -> [Fr; D] {
    let mut a = [Fr::from(0u64); D];
    a.copy_from_slice(&v[..D]);
    a
}
fn bits<const D: usize>(v: &[bool]) -> [bool; D] {
    let mut a = [false; D];
    a.copy_from_slice(&v[..D]);
    a
}

/// Outcome of building a spend: the circuit, the trees after it, and the sender's next blinding.
pub struct BuiltSpend<H: Hash2, const D: usize> {
    pub circuit: SpendCircuit<D>,
    pub trees: SpendTrees<H, D>,
    pub sender_next_blinding: Fr,
}

/// Build a spend against real trees. `layout` V6 rotates the sender blinding and opens empty
/// slots; V5Legacy reproduces the v5 rules (sender keeps its blinding, no empty slots).
pub fn build_spend<H: SpendHash, const D: usize>(
    trees: &SpendTrees<H, D>,
    p: &SpendParams,
    layout: SpendLayout,
) -> Result<BuiltSpend<H, D>, String> {
    let fee = expected_fee(p.amount);
    if p.amount == 0 {
        return Err("ZERO_AMOUNT".into());
    }
    let sender_new_bal = p
        .sender_old_balance
        .checked_sub(p.amount)
        .and_then(|v| v.checked_sub(fee))
        .ok_or("INSUFFICIENT_BALANCE")?;
    let r_new_bal = p.recipient.old_balance.checked_add(p.amount).ok_or("AMOUNT_OVERFLOW")?;
    let t_new_bal = p.treasury.old_balance.checked_add(fee).ok_or("AMOUNT_OVERFLOW")?;

    let sender_id = h_account::<H>(p.secret, p.salt);
    let asset = p.asset;
    let s_old = note_commitment::<H>(sender_id, asset, Fr::from(p.sender_old_balance), p.sender_blinding);
    let nonce = note_nonce::<H>(s_old, p.sender_blinding);
    let nullifier = h_nullifier::<H>(p.secret, nonce);
    let s_new_blind = match layout {
        SpendLayout::V6 => rotate_blinding::<H>(p.secret, nonce),
        SpendLayout::V5Legacy => p.sender_blinding,
    };
    let s_new = note_commitment::<H>(sender_id, asset, Fr::from(sender_new_bal), s_new_blind);

    let s_idx = state_index::<H>(sender_id, asset, D);
    let r_idx = state_index::<H>(p.recipient.id, asset, D);
    let t_idx = state_index::<H>(p.treasury.id, asset, D);
    if s_idx == r_idx || s_idx == t_idx || r_idx == t_idx {
        return Err("SMT_INDEX_COLLISION: parties share a state slot".into());
    }
    let mut state = trees.state.clone();
    if state.get_leaf(s_idx) != s_old {
        return Err("SENDER_LEAF_MISMATCH: sender slot does not hold the claimed balance/blinding".into());
    }

    // Receiving parties: slot holds their leaf, or is empty (V6 only, balance 0).
    let party_old = |state: &NativeSmt<H, D>, idx: u64, party: &Party| -> Result<(Fr, bool), String> {
        let expected = note_commitment::<H>(party.id, asset, Fr::from(party.old_balance), party.blinding);
        let cur = state.get_leaf(idx);
        if cur == expected {
            Ok((expected, false))
        } else if cur == Fr::from(0u64) && party.old_balance == 0 && layout == SpendLayout::V6 {
            Ok((Fr::from(0u64), true))
        } else if cur == Fr::from(0u64) {
            Err("EMPTY_SLOT_NOT_SUPPORTED_IN_V5: receiving slot is empty".into())
        } else {
            Err("SMT_INDEX_COLLISION_OR_STALE: receiving slot holds another leaf".into())
        }
    };

    let old_state_root = state.root();
    let (s_sibs, s_bits) = state.path(s_idx);
    state.set(s_idx, s_new);
    let mid1 = state.root();

    let (r_old, r_empty) = party_old(&state, r_idx, &p.recipient)?;
    let r_new = note_commitment::<H>(p.recipient.id, asset, Fr::from(r_new_bal), p.recipient.blinding);
    let (r_sibs, r_bits) = state.path(r_idx);
    state.set(r_idx, r_new);
    let mid2 = state.root();

    let (t_old, t_empty) = party_old(&state, t_idx, &p.treasury)?;
    let t_new = note_commitment::<H>(p.treasury.id, asset, Fr::from(t_new_bal), p.treasury.blinding);
    let (t_sibs, t_bits) = state.path(t_idx);
    state.set(t_idx, t_new);
    let new_state_root = state.root();

    let mut nfs = trees.nullifiers.clone();
    let nf_idx = low_bits_u64(nullifier, D);
    if nfs.get_leaf(nf_idx) != Fr::from(0u64) {
        return Err("NULLIFIER_SLOT_OCCUPIED".into());
    }
    let old_nf_root = nfs.root();
    let (nf_sibs, nf_bits) = nfs.path(nf_idx);
    nfs.set(nf_idx, nullifier);
    let new_nf_root = nfs.root();

    let domain_fr = Fr::from(p.domain_id);
    let amount_fr = Fr::from(p.amount);
    let fee_fr = Fr::from(fee);
    let transaction_commitment = tx_commitment::<H>(
        old_state_root, new_state_root, old_nf_root, new_nf_root, sender_id, p.recipient.id,
        p.treasury.id, asset, amount_fr, fee_fr, nullifier, domain_fr,
    );

    let circuit = SpendCircuit::<D> {
        old_state_root,
        new_state_root,
        old_nullifier_root: old_nf_root,
        new_nullifier_root: new_nf_root,
        sender_id,
        recipient_id: p.recipient.id,
        treasury_id: p.treasury.id,
        asset_id: asset,
        amount: amount_fr,
        fee: fee_fr,
        nullifier,
        transaction_commitment,
        domain_id: domain_fr,
        sender_secret: p.secret,
        sender_salt: p.salt,
        note_blinding: p.sender_blinding,
        note_nonce: nonce,
        sender_old_amount: Fr::from(p.sender_old_balance),
        sender_new_amount: Fr::from(sender_new_bal),
        recipient_old_amount: Fr::from(p.recipient.old_balance),
        recipient_new_amount: Fr::from(r_new_bal),
        treasury_old_amount: Fr::from(p.treasury.old_balance),
        treasury_new_amount: Fr::from(t_new_bal),
        mid_root_after_sender: mid1,
        mid_root_after_recipient: mid2,
        sender_index: s_idx,
        sender_siblings: arr(&s_sibs),
        sender_index_bits: bits(&s_bits),
        sender_old_leaf: s_old,
        sender_new_leaf: s_new,
        recipient_index: r_idx,
        recipient_siblings: arr(&r_sibs),
        recipient_index_bits: bits(&r_bits),
        recipient_old_leaf: r_old,
        recipient_new_leaf: r_new,
        recipient_blinding: p.recipient.blinding,
        treasury_index: t_idx,
        treasury_siblings: arr(&t_sibs),
        treasury_index_bits: bits(&t_bits),
        treasury_old_leaf: t_old,
        treasury_new_leaf: t_new,
        treasury_blinding: p.treasury.blinding,
        nullifier_index: nf_idx,
        nullifier_siblings: arr(&nf_sibs),
        nullifier_index_bits: bits(&nf_bits),
        nullifier_leaf: nullifier,
        use_poseidon: H::POSEIDON,
        layout,
        sender_new_blinding: s_new_blind,
        recipient_slot_empty: r_empty,
        treasury_slot_empty: t_empty,
    };
    Ok(BuiltSpend { circuit, trees: SpendTrees { state, nullifiers: nfs }, sender_next_blinding: s_new_blind })
}

// ---------------------------------------------------------------------------
// Native predicate
// ---------------------------------------------------------------------------

fn is_u64(x: Fr) -> bool {
    let r = x.into_repr();
    r.0[1] == 0 && r.0[2] == 0 && r.0[3] == 0
}

fn root_native<H: Hash2>(leaf: Fr, sibs: &[Fr], bits: &[bool]) -> Fr {
    let mut cur = leaf;
    for (s, b) in sibs.iter().zip(bits.iter()) {
        cur = if *b { h_merkle::<H>(*s, cur) } else { h_merkle::<H>(cur, *s) };
    }
    cur
}

/// Index + direction bits accepted by the circuit: idx < 2^D, bits = LE bits of idx,
/// and idx = lowBits(key, D).
fn index_ok<const D: usize>(key: Fr, idx: u64, bits_in: &[bool; D]) -> bool {
    if D < 64 && idx >> D != 0 {
        return false;
    }
    index_to_direction_bits(idx, D).as_slice() == &bits_in[..] && low_bits_u64(key, D) == idx
}

/// Native statement of the spend relation, written independently of the R1CS code.
/// Returns true iff the given public inputs + witness satisfy every rule of `c.layout`.
pub fn spend_valid<H: Hash2, const D: usize>(c: &SpendCircuit<D>) -> bool {
    let zero = Fr::from(0u64);
    let leaf = |owner: Fr, amount: Fr, blind: Fr| {
        let inner = h_leaf::<H>(c.asset_id, amount);
        let payload = h_leaf::<H>(owner, inner);
        h_leaf::<H>(payload, blind)
    };
    // 1. public commitment
    if tx_commitment::<H>(
        c.old_state_root, c.new_state_root, c.old_nullifier_root, c.new_nullifier_root,
        c.sender_id, c.recipient_id, c.treasury_id, c.asset_id, c.amount, c.fee, c.nullifier,
        c.domain_id,
    ) != c.transaction_commitment
    {
        return false;
    }
    // 2. ownership + nullifier
    if h_account::<H>(c.sender_secret, c.sender_salt) != c.sender_id {
        return false;
    }
    if h_nullifier::<H>(c.sender_secret, c.note_nonce) != c.nullifier {
        return false;
    }
    // 3. ranges, fee, balance equations
    let vals = [
        c.amount, c.fee, c.sender_old_amount, c.sender_new_amount, c.recipient_old_amount,
        c.recipient_new_amount, c.treasury_old_amount, c.treasury_new_amount,
    ];
    if !vals.iter().all(|v| is_u64(*v)) {
        return false;
    }
    let amount_u = c.amount.into_repr().0[0];
    if amount_u == 0 || Fr::from(expected_fee(amount_u)) != c.fee {
        return false;
    }
    if c.sender_new_amount + c.amount + c.fee != c.sender_old_amount
        || c.recipient_old_amount + c.amount != c.recipient_new_amount
        || c.treasury_old_amount + c.fee != c.treasury_new_amount
    {
        return false;
    }
    // 4. leaves
    if leaf(c.sender_id, c.sender_old_amount, c.note_blinding) != c.sender_old_leaf {
        return false;
    }
    if h_leaf::<H>(c.sender_old_leaf, c.note_blinding) != c.note_nonce {
        return false;
    }
    let s_new_blind = match c.layout {
        SpendLayout::V5Legacy => c.note_blinding,
        SpendLayout::V6 => {
            if rotate_blinding::<H>(c.sender_secret, c.note_nonce) != c.sender_new_blinding {
                return false;
            }
            c.sender_new_blinding
        }
    };
    if leaf(c.sender_id, c.sender_new_amount, s_new_blind) != c.sender_new_leaf {
        return false;
    }
    let party_old_ok = |owner: Fr, amount: Fr, blind: Fr, old_leaf: Fr, empty: bool| -> bool {
        if c.layout == SpendLayout::V6 && empty {
            old_leaf == zero && amount == zero
        } else {
            leaf(owner, amount, blind) == old_leaf
        }
    };
    if !party_old_ok(c.recipient_id, c.recipient_old_amount, c.recipient_blinding, c.recipient_old_leaf, c.recipient_slot_empty)
        || leaf(c.recipient_id, c.recipient_new_amount, c.recipient_blinding) != c.recipient_new_leaf
    {
        return false;
    }
    if !party_old_ok(c.treasury_id, c.treasury_old_amount, c.treasury_blinding, c.treasury_old_leaf, c.treasury_slot_empty)
        || leaf(c.treasury_id, c.treasury_new_amount, c.treasury_blinding) != c.treasury_new_leaf
    {
        return false;
    }
    // 5. canonical indices, distinct slots
    if !index_ok::<D>(state_key::<H>(c.sender_id, c.asset_id), c.sender_index, &c.sender_index_bits)
        || !index_ok::<D>(state_key::<H>(c.recipient_id, c.asset_id), c.recipient_index, &c.recipient_index_bits)
        || !index_ok::<D>(state_key::<H>(c.treasury_id, c.asset_id), c.treasury_index, &c.treasury_index_bits)
        || !index_ok::<D>(c.nullifier, c.nullifier_index, &c.nullifier_index_bits)
    {
        return false;
    }
    if c.sender_index == c.recipient_index
        || c.sender_index == c.treasury_index
        || c.recipient_index == c.treasury_index
    {
        return false;
    }
    // 6. sequential state updates and nullifier insert
    let upd = |old_r: Fr, new_r: Fr, ol: Fr, nl: Fr, s: &[Fr; D], b: &[bool; D]| {
        root_native::<H>(ol, s, b) == old_r && root_native::<H>(nl, s, b) == new_r
    };
    upd(c.old_state_root, c.mid_root_after_sender, c.sender_old_leaf, c.sender_new_leaf, &c.sender_siblings, &c.sender_index_bits)
        && upd(c.mid_root_after_sender, c.mid_root_after_recipient, c.recipient_old_leaf, c.recipient_new_leaf, &c.recipient_siblings, &c.recipient_index_bits)
        && upd(c.mid_root_after_recipient, c.new_state_root, c.treasury_old_leaf, c.treasury_new_leaf, &c.treasury_siblings, &c.treasury_index_bits)
        && c.nullifier_leaf == c.nullifier
        && upd(c.old_nullifier_root, c.new_nullifier_root, zero, c.nullifier_leaf, &c.nullifier_siblings, &c.nullifier_index_bits)
}

// ---------------------------------------------------------------------------
// Migration D32 (v5) → D64 (v6)
// ---------------------------------------------------------------------------

/// One balance leaf of a v5 snapshot: the (account, asset) key is needed to re-index at D64
/// because the D32 tree only stores the truncated index.
#[derive(Clone, Debug)]
pub struct BalanceEntry {
    pub account: Fr,
    pub asset: Fr,
    pub leaf: Fr,
}

/// Rebuild a v5 D32 state tree as a v6 D64 tree. Leaf encoding is unchanged, so every leaf
/// stays spendable (its first v6 spend rotates the sender blinding).
/// `expected_d32_root`, when given, must equal the D32 root of the same entries: this proves
/// the entry list is the complete snapshot. Fails on a D64 slot collision.
pub fn migrate_state_d32_to_d64(
    entries: &[BalanceEntry],
    expected_d32_root: Option<Fr>,
) -> Result<NativeSmt<UepPoseidon, 64>, String> {
    if let Some(exp) = expected_d32_root {
        let mut old = NativeSmt::<UepPoseidon, 32>::new();
        for e in entries {
            old.set(state_index::<UepPoseidon>(e.account, e.asset, 32), e.leaf);
        }
        if old.root() != exp {
            return Err("MIGRATION_ROOT_MISMATCH: entries do not reproduce the D32 state root".into());
        }
    }
    let mut t = NativeSmt::<UepPoseidon, 64>::new();
    let mut seen = std::collections::BTreeMap::new();
    for e in entries {
        let idx = state_index::<UepPoseidon>(e.account, e.asset, 64);
        let key = state_key::<UepPoseidon>(e.account, e.asset);
        if let Some(prev) = seen.insert(idx, key) {
            if prev != key {
                return Err("MIGRATION_D64_COLLISION".into());
            }
        }
        t.set(idx, e.leaf);
    }
    Ok(t)
}

/// Rebuild the nullifier tree at D64 (the nullifier is its own key).
pub fn migrate_nullifiers_d32_to_d64(
    nullifiers: &[Fr],
    expected_d32_root: Option<Fr>,
) -> Result<NativeSmt<UepPoseidon, 64>, String> {
    if let Some(exp) = expected_d32_root {
        let mut old = NativeSmt::<UepPoseidon, 32>::new();
        for n in nullifiers {
            old.set(low_bits_u64(*n, 32), *n);
        }
        if old.root() != exp {
            return Err("MIGRATION_ROOT_MISMATCH: nullifiers do not reproduce the D32 root".into());
        }
    }
    let mut t = NativeSmt::<UepPoseidon, 64>::new();
    for n in nullifiers {
        let idx = low_bits_u64(*n, 64);
        let cur = t.get_leaf(idx);
        if cur != Fr::from(0u64) && cur != *n {
            return Err("MIGRATION_D64_COLLISION".into());
        }
        t.set(idx, *n);
    }
    Ok(t)
}

/// Birthday bound: probability that `n` uniformly random keys collide somewhere in 2^d slots,
/// 1 - exp(-n(n-1) / 2^(d+1)).
pub fn collision_probability(n: f64, d: u32) -> f64 {
    1.0 - (-(n * (n - 1.0)) / 2f64.powi(d as i32 + 1)).exp()
}

/// Number of keys at which the collision probability reaches 50 % for 2^d slots.
pub fn keys_at_half(d: u32) -> f64 {
    (2.0 * 2f64.powi(d as i32) * std::f64::consts::LN_2).sqrt()
}

#[cfg(test)]
#[path = "spend_v6_tests.rs"]
mod tests;
