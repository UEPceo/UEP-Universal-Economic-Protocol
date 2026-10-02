//! Prints deterministic UEP-26 Poseidon vectors when arkworks deps resolve.
//! Run: cargo test print_uep26_poseidon_vectors -- --nocapture
//!
//! Outputs are hex of the BN254 Fr little-endian representation (ark-ff default Display
//! is decimal; we also print the raw integer for audit).

use ark_bn254::Fr;
use ark_ff::PrimeField;
use uep21_poseidon_r1cs::{
    uep_domain_hash, uep_note_commitment, uep_note_nonce, uep_note_nullifier, uep_poseidon_hash,
};

fn fr_hex_be(x: Fr) -> String {
    let bytes = x.into_bigint().to_bytes_be();
    format!("0x{}", bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

#[test]
fn print_uep26_poseidon_vectors() {
    let pairs: &[(&str, Fr, Fr)] = &[
        ("PV-001 Poseidon2-input(1,2)", Fr::from(1u64), Fr::from(2u64)),
        ("PV-002 Poseidon2-input(7,11)", Fr::from(7u64), Fr::from(11u64)),
    ];

    println!("=== UEP-26 Poseidon raw 2-input vectors ===");
    for (name, a, b) in pairs {
        let out = uep_poseidon_hash(*a, *b);
        println!("{name} = {out}");
        println!("  bigint = {}", fr_hex_be(out));
    }

    println!("=== UEP-26 domain-separated H(domain,a,b) ===");
    let domains: &[(&str, u64)] = &[
        ("PV-003 H(Account,1,2)", 1),
        ("PV-004 H(Nullifier,1,2)", 2),
        ("PV-005 H(MerkleNode,1,2)", 3),
        ("PV-006 H(Leaf,1,2)", 4),
        ("PV-007 H(Transaction,1,2)", 5),
    ];
    for (name, d) in domains {
        let out = uep_domain_hash(*d, Fr::from(1u64), Fr::from(2u64));
        println!("{name} = {out}");
        println!("  bigint = {}", fr_hex_be(out));
    }

    // Note commitment path (domain composition)
    let owner = Fr::from(1u64);
    let asset = Fr::from(2u64);
    let amount = Fr::from(1000u64);
    let blinding = Fr::from(3u64);
    let commitment = uep_note_commitment(owner, asset, amount, blinding);
    let nonce = uep_note_nonce(commitment, blinding);
    let nullifier = uep_note_nullifier(Fr::from(10u64), nonce);

    println!("=== UEP-26 note path ===");
    println!("PV-008 note_commitment(owner=1,asset=2,amount=1000,blinding=3) = {commitment}");
    println!("  bigint = {}", fr_hex_be(commitment));
    println!("PV-008b note_nonce = {nonce}");
    println!("  bigint = {}", fr_hex_be(nonce));
    println!("PV-009 nullifier(secret=10, nonce) = {nullifier}");
    println!("  bigint = {}", fr_hex_be(nullifier));

    // PV-001 is a committed cross-implementation golden vector.
    let pv001 = uep_poseidon_hash(Fr::from(1u64), Fr::from(2u64));
    assert_eq!(
        fr_hex_be(pv001),
        "0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a"
    );
}
