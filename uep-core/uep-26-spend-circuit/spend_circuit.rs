//! SpendCircuit synthesizer (UEP-26.7).
//!
//! Wires in one circuit:
//! - ownership: sender_id = H_ACCOUNT(secret, salt)
//! - nullifier: public nullifier = H_NULLIFIER(secret, note_nonce)
//! - fee + balance equations + u64 range
//! - sequential state-tree updates: sender → recipient → treasury
//!   (intermediate roots are private witnesses; public old/new state roots bound at ends)
//! - nullifier-tree insert at empty slot
//! - transaction_commitment = H_fold(D_TX, [version, …public fields])
//!
//! Not a production Groth16-ready circuit.

use ark_bn254::Fr;
use ark_r1cs_std::{
    alloc::AllocVar,
    eq::EqGadget,
    fields::fp::FpVar,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use crate::hash_gadget::{
    domain_hash_gadget, enforce_domain_hash, enforce_tx_commitment, h_account, h_nullifier,
    note_commitment, note_nonce, tx_commitment, Hash2, Hash2Gadget, StructuralTestHash,
    UepPoseidon, D_ACCOUNT, D_LEAF, D_NULLIFIER, ENCODING_VERSION,
};
use crate::smt_gadget::{
    enforce_low_bits_index, enforce_not_equal, enforce_nullifier_insert, enforce_update,
    index_to_direction_bits, low_bits_u64, state_index,
};
use crate::{enforce_fee_policy, enforce_u64, expected_fee};

/// Witness + public inputs for a single-asset transfer with Merkle depth D.
#[derive(Clone)]
pub struct SpendCircuit<const D: usize> {
    // Public (canonical order §3; commitment last)
    pub old_state_root: Fr,
    pub new_state_root: Fr,
    pub old_nullifier_root: Fr,
    pub new_nullifier_root: Fr,
    pub sender_id: Fr,
    pub recipient_id: Fr,
    pub treasury_id: Fr,
    pub asset_id: Fr,
    pub amount: Fr,
    pub fee: Fr,
    pub nullifier: Fr,
    pub transaction_commitment: Fr,
    /// Network domain. Public input 13. Also folded into the commitment.
    pub domain_id: Fr,

    // Private — ownership / note
    pub sender_secret: Fr,
    pub sender_salt: Fr,
    pub note_blinding: Fr,
    pub note_nonce: Fr,

    // Private — balances
    pub sender_old_amount: Fr,
    pub sender_new_amount: Fr,
    pub recipient_old_amount: Fr,
    pub recipient_new_amount: Fr,
    pub treasury_old_amount: Fr,
    pub treasury_new_amount: Fr,

    // Private — sequential intermediate state roots
    pub mid_root_after_sender: Fr,
    pub mid_root_after_recipient: Fr,

    // Private — sender path
    pub sender_index: u64,
    pub sender_siblings: [Fr; D],
    pub sender_index_bits: [bool; D],
    pub sender_old_leaf: Fr,
    pub sender_new_leaf: Fr,

    // Private — recipient path
    pub recipient_index: u64,
    pub recipient_siblings: [Fr; D],
    pub recipient_index_bits: [bool; D],
    pub recipient_old_leaf: Fr,
    pub recipient_new_leaf: Fr,
    pub recipient_blinding: Fr,

    // Private — treasury path
    pub treasury_index: u64,
    pub treasury_siblings: [Fr; D],
    pub treasury_index_bits: [bool; D],
    pub treasury_old_leaf: Fr,
    pub treasury_new_leaf: Fr,
    pub treasury_blinding: Fr,

    // Private — nullifier path
    pub nullifier_index: u64,
    pub nullifier_siblings: [Fr; D],
    pub nullifier_index_bits: [bool; D],
    pub nullifier_leaf: Fr,

    pub use_poseidon: bool,
}

fn bind_balance_leaf<G: Hash2Gadget>(
    cs: ConstraintSystemRef<Fr>,
    owner: &FpVar<Fr>,
    asset: &FpVar<Fr>,
    amount: &FpVar<Fr>,
    blinding: &FpVar<Fr>,
    leaf_out: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    let inner = domain_hash_gadget::<G>(cs.clone(), D_LEAF, asset, amount)?;
    let payload = domain_hash_gadget::<G>(cs.clone(), D_LEAF, owner, &inner)?;
    let computed = domain_hash_gadget::<G>(cs, D_LEAF, &payload, blinding)?;
    computed.enforce_equal(leaf_out)
}

impl<const D: usize> SpendCircuit<D> {
    fn gen_hash2<G: Hash2 + Hash2Gadget>(
        self,
        cs: ConstraintSystemRef<Fr>,
    ) -> Result<(), SynthesisError> {
        // ---- Public inputs (order §3) ----
        let old_state_root = FpVar::new_input(cs.clone(), || Ok(self.old_state_root))?;
        let new_state_root = FpVar::new_input(cs.clone(), || Ok(self.new_state_root))?;
        let old_nullifier_root = FpVar::new_input(cs.clone(), || Ok(self.old_nullifier_root))?;
        let new_nullifier_root = FpVar::new_input(cs.clone(), || Ok(self.new_nullifier_root))?;
        let sender_id = FpVar::new_input(cs.clone(), || Ok(self.sender_id))?;
        let recipient_id = FpVar::new_input(cs.clone(), || Ok(self.recipient_id))?;
        let treasury_id = FpVar::new_input(cs.clone(), || Ok(self.treasury_id))?;
        let asset_id = FpVar::new_input(cs.clone(), || Ok(self.asset_id))?;
        let amount = FpVar::new_input(cs.clone(), || Ok(self.amount))?;
        let fee = FpVar::new_input(cs.clone(), || Ok(self.fee))?;
        let nullifier_pub = FpVar::new_input(cs.clone(), || Ok(self.nullifier))?;
        let tx_commit_pub = FpVar::new_input(cs.clone(), || Ok(self.transaction_commitment))?;
        let domain_id = FpVar::new_input(cs.clone(), || Ok(self.domain_id))?;

        // ---- Tx commitment binding ----
        let version = FpVar::new_constant(cs.clone(), Fr::from(ENCODING_VERSION))?;
        enforce_tx_commitment::<G>(
            cs.clone(),
            &tx_commit_pub,
            &[
                version,
                old_state_root.clone(),
                new_state_root.clone(),
                old_nullifier_root.clone(),
                new_nullifier_root.clone(),
                sender_id.clone(),
                recipient_id.clone(),
                treasury_id.clone(),
                asset_id.clone(),
                amount.clone(),
                fee.clone(),
                nullifier_pub.clone(),
                domain_id.clone(),
            ],
        )?;

        // ---- Ownership ----
        let secret = FpVar::new_witness(cs.clone(), || Ok(self.sender_secret))?;
        let salt = FpVar::new_witness(cs.clone(), || Ok(self.sender_salt))?;
        enforce_domain_hash::<G>(cs.clone(), D_ACCOUNT, &secret, &salt, &sender_id)?;

        // ---- Nullifier derivation ----
        let note_nonce_v = FpVar::new_witness(cs.clone(), || Ok(self.note_nonce))?;
        enforce_domain_hash::<G>(
            cs.clone(),
            D_NULLIFIER,
            &secret,
            &note_nonce_v,
            &nullifier_pub,
        )?;

        // ---- Amounts / fee / balances ----
        let sender_old = FpVar::new_witness(cs.clone(), || Ok(self.sender_old_amount))?;
        let sender_new = FpVar::new_witness(cs.clone(), || Ok(self.sender_new_amount))?;
        let recipient_old = FpVar::new_witness(cs.clone(), || Ok(self.recipient_old_amount))?;
        let recipient_new = FpVar::new_witness(cs.clone(), || Ok(self.recipient_new_amount))?;
        let treasury_old = FpVar::new_witness(cs.clone(), || Ok(self.treasury_old_amount))?;
        let treasury_new = FpVar::new_witness(cs.clone(), || Ok(self.treasury_new_amount))?;

        for x in [
            &amount,
            &fee,
            &sender_old,
            &sender_new,
            &recipient_old,
            &recipient_new,
            &treasury_old,
            &treasury_new,
        ] {
            enforce_u64(cs.clone(), x)?;
        }
        enforce_fee_policy(cs.clone(), &amount, &fee)?;
        (&sender_new + &amount + &fee).enforce_equal(&sender_old)?;
        (&recipient_old + &amount).enforce_equal(&recipient_new)?;
        (&treasury_old + &fee).enforce_equal(&treasury_new)?;
        (&sender_old + &recipient_old + &treasury_old)
            .enforce_equal(&(&sender_new + &recipient_new + &treasury_new))?;

        // ---- Leaf bindings ----
        let s_blind = FpVar::new_witness(cs.clone(), || Ok(self.note_blinding))?;
        let s_old_leaf = FpVar::new_witness(cs.clone(), || Ok(self.sender_old_leaf))?;
        let s_new_leaf = FpVar::new_witness(cs.clone(), || Ok(self.sender_new_leaf))?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &sender_id,
            &asset_id,
            &sender_old,
            &s_blind,
            &s_old_leaf,
        )?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &sender_id,
            &asset_id,
            &sender_new,
            &s_blind,
            &s_new_leaf,
        )?;

        // ---- note_nonce must be the protocol nonce of the spent note ----
        // note_nonce = H_LEAF(sender_old_leaf, sender_blinding)
        let expected_nonce =
            domain_hash_gadget::<G>(cs.clone(), D_LEAF, &s_old_leaf, &s_blind)?;
        expected_nonce.enforce_equal(&note_nonce_v)?;

        let r_blind = FpVar::new_witness(cs.clone(), || Ok(self.recipient_blinding))?;
        let r_old_leaf = FpVar::new_witness(cs.clone(), || Ok(self.recipient_old_leaf))?;
        let r_new_leaf = FpVar::new_witness(cs.clone(), || Ok(self.recipient_new_leaf))?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &recipient_id,
            &asset_id,
            &recipient_old,
            &r_blind,
            &r_old_leaf,
        )?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &recipient_id,
            &asset_id,
            &recipient_new,
            &r_blind,
            &r_new_leaf,
        )?;

        let t_blind = FpVar::new_witness(cs.clone(), || Ok(self.treasury_blinding))?;
        let t_old_leaf = FpVar::new_witness(cs.clone(), || Ok(self.treasury_old_leaf))?;
        let t_new_leaf = FpVar::new_witness(cs.clone(), || Ok(self.treasury_new_leaf))?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &treasury_id,
            &asset_id,
            &treasury_old,
            &t_blind,
            &t_old_leaf,
        )?;
        bind_balance_leaf::<G>(
            cs.clone(),
            &treasury_id,
            &asset_id,
            &treasury_new,
            &t_blind,
            &t_new_leaf,
        )?;

        // ---- Sequential state updates: old → mid1 → mid2 → new ----
        let mid1 = FpVar::new_witness(cs.clone(), || Ok(self.mid_root_after_sender))?;
        let mid2 = FpVar::new_witness(cs.clone(), || Ok(self.mid_root_after_recipient))?;

        // Canonical SMT address (V47-02): index = lowBits(H_ACCOUNT(account_id, asset_id), D),
        // one leaf per (account, asset) pair, the same key as the public ledger's SMT.
        let s_key = domain_hash_gadget::<G>(cs.clone(), D_ACCOUNT, &sender_id, &asset_id)?;
        let r_key = domain_hash_gadget::<G>(cs.clone(), D_ACCOUNT, &recipient_id, &asset_id)?;
        let t_key = domain_hash_gadget::<G>(cs.clone(), D_ACCOUNT, &treasury_id, &asset_id)?;
        let s_idx = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.sender_index)))?;
        let r_idx = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.recipient_index)))?;
        let t_idx = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.treasury_index)))?;
        enforce_low_bits_index(cs.clone(), &s_key, &s_idx, D)?;
        enforce_low_bits_index(cs.clone(), &r_key, &r_idx, D)?;
        enforce_low_bits_index(cs.clone(), &t_key, &t_idx, D)?;
        // The three leaves must sit in distinct slots: a truncated-key collision
        // between the parties is rejected instead of overwriting a leaf.
        enforce_not_equal(cs.clone(), &s_idx, &r_idx)?;
        enforce_not_equal(cs.clone(), &s_idx, &t_idx)?;
        enforce_not_equal(cs.clone(), &r_idx, &t_idx)?;
        let s_sibs: Vec<_> = self
            .sender_siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)))
            .collect::<Result<Vec<_>, _>>()?;
        enforce_update::<G>(
            cs.clone(),
            &old_state_root,
            &mid1,
            &s_old_leaf,
            &s_new_leaf,
            &s_idx,
            &s_sibs,
            Some(&self.sender_index_bits),
        )?;

        let r_sibs: Vec<_> = self
            .recipient_siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)))
            .collect::<Result<Vec<_>, _>>()?;
        enforce_update::<G>(
            cs.clone(),
            &mid1,
            &mid2,
            &r_old_leaf,
            &r_new_leaf,
            &r_idx,
            &r_sibs,
            Some(&self.recipient_index_bits),
        )?;

        let t_sibs: Vec<_> = self
            .treasury_siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)))
            .collect::<Result<Vec<_>, _>>()?;
        enforce_update::<G>(
            cs.clone(),
            &mid2,
            &new_state_root,
            &t_old_leaf,
            &t_new_leaf,
            &t_idx,
            &t_sibs,
            Some(&self.treasury_index_bits),
        )?;

        // ---- Nullifier insert ----
        let nf_idx = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.nullifier_index)))?;
        // Canonical nullifier slot: index = lowBits(nullifier, D)
        enforce_low_bits_index(cs.clone(), &nullifier_pub, &nf_idx, D)?;
        let nf_leaf = FpVar::new_witness(cs.clone(), || Ok(self.nullifier_leaf))?;
        nf_leaf.enforce_equal(&nullifier_pub)?;
        let nf_sibs: Vec<_> = self
            .nullifier_siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)))
            .collect::<Result<Vec<_>, _>>()?;
        enforce_nullifier_insert::<G>(
            cs,
            &old_nullifier_root,
            &new_nullifier_root,
            &nf_leaf,
            &nf_idx,
            &nf_sibs,
            Some(&self.nullifier_index_bits),
        )?;

        Ok(())
    }
}

impl<const D: usize> ConstraintSynthesizer<Fr> for SpendCircuit<D> {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        if self.use_poseidon {
            self.gen_hash2::<UepPoseidon>(cs)
        } else {
            self.gen_hash2::<StructuralTestHash>(cs)
        }
    }
}

fn structural_root(leaf: Fr, siblings: &[Fr], bits: &[bool]) -> Fr {
    use crate::hash_gadget::h_merkle;
    let mut cur = leaf;
    for (sib, bit) in siblings.iter().zip(bits.iter()) {
        cur = if *bit {
            h_merkle::<StructuralTestHash>(*sib, cur)
        } else {
            h_merkle::<StructuralTestHash>(cur, *sib)
        };
    }
    cur
}

fn path_arrays<const D: usize>(index: u64) -> ([Fr; D], [bool; D]) {
    let bits_v = index_to_direction_bits(index, D);
    let mut bits = [false; D];
    bits.copy_from_slice(&bits_v[..D]);
    // Zero siblings → independent paths only if indices differ; sequential roots still chain.
    ([Fr::from(0u64); D], bits)
}

/// Honest fixture using StructuralTestHash and sequential mid-roots.
pub fn honest_spend_fixture_structural<const D: usize>(
    amount: u64,
    sender_old_bal: u64,
) -> SpendCircuit<D> {
    let fee = expected_fee(amount);
    let secret = Fr::from(42u64);
    let salt = Fr::from(7u64);
    let sender_id = h_account::<StructuralTestHash>(secret, salt);
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

    let s_old = note_commitment::<StructuralTestHash>(sender_id, asset, sender_old_amount, s_blind);
    let s_new = note_commitment::<StructuralTestHash>(sender_id, asset, sender_new_amount, s_blind);
    let r_old =
        note_commitment::<StructuralTestHash>(recipient_id, asset, recipient_old_amount, r_blind);
    let r_new =
        note_commitment::<StructuralTestHash>(recipient_id, asset, recipient_new_amount, r_blind);
    let t_old =
        note_commitment::<StructuralTestHash>(treasury_id, asset, treasury_old_amount, t_blind);
    let t_new =
        note_commitment::<StructuralTestHash>(treasury_id, asset, treasury_new_amount, t_blind);

    let nonce = note_nonce::<StructuralTestHash>(s_old, s_blind);
    let nullifier = h_nullifier::<StructuralTestHash>(secret, nonce);

    // Canonical SMT indices = lowBits(H_ACCOUNT(id, asset), D)
    let s_idx = state_index::<StructuralTestHash>(sender_id, asset, D);
    let r_idx = state_index::<StructuralTestHash>(recipient_id, asset, D);
    let t_idx = state_index::<StructuralTestHash>(treasury_id, asset, D);
    let nf_idx = low_bits_u64(nullifier, D);
    // Collision guard for unit tests (distinct accounts)
    assert!(s_idx != r_idx && r_idx != t_idx && s_idx != t_idx, "index collision in fixture");


    let (mut s_sibs, s_bits) = path_arrays::<D>(s_idx);
    let (mut r_sibs, r_bits) = path_arrays::<D>(r_idx);
    let (mut t_sibs, t_bits) = path_arrays::<D>(t_idx);
    let (nf_sibs, nf_bits) = path_arrays::<D>(nf_idx);

    // Build sender path siblings so roots are well-defined (zeros already fine).
    let old_state_root = structural_root(s_old, &s_sibs, &s_bits);
    let mid1 = structural_root(s_new, &s_sibs, &s_bits);

    // Craft recipient siblings so root(r_old)=mid1 and root(r_new)=desired mid2.
    // First craft path to mid1 for r_old.
    craft_siblings_to_root(&mut r_sibs, &r_bits, r_old, mid1);
    assert_eq!(structural_root(r_old, &r_sibs, &r_bits), mid1);

    // mid2 from r_new with same siblings (update property: same path).
    let mid2 = structural_root(r_new, &r_sibs, &r_bits);

    // Craft treasury siblings so root(t_old)=mid2, root(t_new)=new_state_root.
    craft_siblings_to_root(&mut t_sibs, &t_bits, t_old, mid2);
    assert_eq!(structural_root(t_old, &t_sibs, &t_bits), mid2);
    let new_state_root = structural_root(t_new, &t_sibs, &t_bits);

    let empty = Fr::from(0u64);
    let old_nf_root = structural_root(empty, &nf_sibs, &nf_bits);
    let new_nf_root = structural_root(nullifier, &nf_sibs, &nf_bits);

    let transaction_commitment = tx_commitment::<StructuralTestHash>(
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
        Fr::from(1u64),
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
        transaction_commitment,
        domain_id: Fr::from(1u64),
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
        sender_siblings: s_sibs,
        sender_index_bits: s_bits,
        sender_old_leaf: s_old,
        sender_new_leaf: s_new,
        recipient_index: r_idx,
        recipient_siblings: {
            let mut a = [Fr::from(0u64); D];
            a.copy_from_slice(&r_sibs[..D]);
            a
        },
        recipient_index_bits: r_bits,
        recipient_old_leaf: r_old,
        recipient_new_leaf: r_new,
        recipient_blinding: r_blind,
        treasury_index: t_idx,
        treasury_siblings: {
            let mut a = [Fr::from(0u64); D];
            a.copy_from_slice(&t_sibs[..D]);
            a
        },
        treasury_index_bits: t_bits,
        treasury_old_leaf: t_old,
        treasury_new_leaf: t_new,
        treasury_blinding: t_blind,
        nullifier_index: nf_idx,
        nullifier_siblings: nf_sibs,
        nullifier_index_bits: nf_bits,
        nullifier_leaf: nullifier,
        use_poseidon: false,
    }
}

/// Craft siblings so structural Merkle root(leaf)=target (StructuralTestHash only).
fn craft_siblings_to_root(siblings: &mut [Fr], bits: &[bool], leaf: Fr, target: Fr) {
    // Work bottom-up: we need intermediate nodes. Easier top-down with inversion.
    // structural H_MERKLE(L,R) = 2L + R + 15  (see derivation above for domain 3).
    // Verify formula matches implementation:
    // hash2(a,b)=2a+b+1; domain_hash(3,L,R)=hash2(hash2(3,L),R)=hash2(2*3+L+1,R)=hash2(7+L,R)=2(7+L)+R+1=14+2L+R+1=2L+R+15.
    let mut cur = leaf;
    // We need siblings such that going up reaches target. Top-down:
    // Collect needed parents from leaf to root by first computing with current siblings,
    // then replace. Algorithm: from root down, assign sibling to force parent chain.
    // Store path nodes from leaf up with current siblings, then fix.
    // Better: from leaf upward, at each step choose sibling so we can still reach target —
    // underdetermined. Top-down:
    let depth = siblings.len();
    let mut nodes = vec![Fr::from(0u64); depth + 1];
    nodes[0] = leaf;
    // Place target at root and invert down to leaf (then leaf must match).
    // Invert from root to leaf:
    let mut parent = target;
    let mut computed_sibs = vec![Fr::from(0u64); depth];
    // We need path nodes at each level. Going from root down to leaf:
    // At level i from the top (i=depth-1 ... 0), bit is bits[i], parent is known,
    // cur at this level is unknown until we go further... 
    // Bottom-up inversion: start from leaf, at each level sibling is free — set sibling=0
    // first, then fix from top.
    //
    // From root downward:
    // parents[depth] = target
    // for i from depth-1 downto 0:
    //   bit = bits[i]
    //   We need parent = H(left,right). One of left/right is child (nodes[i]), other is sib.
    //   Child is not known yet if we go top-down.
    //
    // Bottom-up with free siblings set to make final root = target:
    // Only last sibling degree of freedom at top level can adjust root if hash is invertible in one arg.
    // For depth>1, set lower siblings to 0, solve top sibling.
    for s in siblings.iter_mut() {
        *s = Fr::from(0u64);
    }
    // Compute root with zero sibs, then adjust level by level from the top.
    // For each level from root-1 down, invert.
    // Path: nodes[0]=leaf; nodes[i+1]=parent(nodes[i], sibs[i], bits[i])
    // We want nodes[depth]=target.
    // Set nodes[depth]=target; for i = depth-1 downto 0: solve for nodes[i] and sibs[i]
    // given nodes[i+1] and bits[i]. One degree of freedom: keep nodes[0]=leaf fixed
    // by solving only for sibs from the bottom with intermediate nodes determined
    // from leaf up — then adjust.
    //
    // Method: compute intermediate parents from leaf with sib=0; then at the top
    // level, solve for the top sibling so parent becomes target. Only works for
    // correcting the final step; intermediate nodes fixed.
    let mut cur = leaf;
    for i in 0..depth - 1 {
        cur = structural_parent(cur, siblings[i], bits[i]);
    }
    // Now cur is node at level depth-1; set siblings[depth-1] so parent is target.
    siblings[depth - 1] = solve_sibling(cur, bits[depth - 1], target);
    // Verify
    let got = structural_root(leaf, siblings, bits);
    assert_eq!(got, target, "craft_siblings failed");
}

fn structural_parent(cur: Fr, sib: Fr, bit: bool) -> Fr {
    use crate::hash_gadget::h_merkle;
    if bit {
        h_merkle::<StructuralTestHash>(sib, cur)
    } else {
        h_merkle::<StructuralTestHash>(cur, sib)
    }
}

fn solve_sibling(cur: Fr, bit: bool, parent: Fr) -> Fr {
    // H_MERKLE(L,R) = 2L + R + 15
    // bit0: L=cur, R=sib => parent = 2*cur + sib + 15 => sib = parent - 2*cur - 15
    // bit1: L=sib, R=cur => parent = 2*sib + cur + 15 => 2*sib = parent - cur - 15
    use ark_ff::Field;
    if !bit {
        parent - cur - cur - Fr::from(15u64)
    } else {
        let two_inv = Fr::from(2u64).inverse().unwrap();
        (parent - cur - Fr::from(15u64)) * two_inv
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn c1_honest_spend_accepted() {
        let c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap(), "constraints unsatisfied");
    }

    #[test]
    fn c1_wrong_secret_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.sender_secret = Fr::from(43u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c2_wrong_nullifier_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.nullifier = Fr::from(12345u64);
        c.nullifier_leaf = c.nullifier;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c3_altered_sender_direction_bit_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.sender_index_bits[0] = !c.sender_index_bits[0];
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c3_altered_recipient_sibling_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.recipient_siblings[0] = c.recipient_siblings[0] + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c3_cross_path_sender_recipient_rejected() {
        // Swap recipient siblings onto sender path geometry mismatch
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.recipient_index_bits = c.sender_index_bits;
        c.recipient_index = c.sender_index;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn distinct_party_slots_required() {
        // Placing two parties in the same state slot (even with otherwise
        // consistent witnesses) is unsatisfiable: collisions are rejected.
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.treasury_index = c.recipient_index;
        c.treasury_index_bits = c.recipient_index_bits;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn state_index_depends_on_asset() {
        use crate::hash_gadget::UepPoseidon;
        let acct = Fr::from(123_456_789u64);
        let a = state_index::<UepPoseidon>(acct, Fr::from(1u64), 32);
        let b = state_index::<UepPoseidon>(acct, Fr::from(2u64), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn c4_wrong_fee_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000_000, 2_000_000);
        c.fee = Fr::from(expected_fee(1_000_000) + 1);
        c.sender_new_amount = Fr::from(2_000_000u64 - 1_000_000 - (expected_fee(1_000_000) + 1));
        c.treasury_new_amount = c.fee;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c7_altered_tx_commitment_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.transaction_commitment = c.transaction_commitment + Fr::from(1u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c7_amount_change_breaks_commitment_and_balances() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.amount = Fr::from(1001u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c8_nullifier_reuse_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.old_nullifier_root = c.new_nullifier_root;
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }

    #[test]
    fn c6_treasury_path_tamper_rejected() {
        let mut c = honest_spend_fixture_structural::<3>(1_000, 10_000);
        c.treasury_siblings[0] = c.treasury_siblings[0] + Fr::from(7u64);
        let cs = ConstraintSystem::<Fr>::new_ref();
        c.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap());
    }
}
