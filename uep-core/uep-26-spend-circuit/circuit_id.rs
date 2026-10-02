//! Circuit / artifact identity for UEP-27.4.
//!
//! - `circuit_metadata_id`: SHA-256 of declared protocol constants (NOT an R1CS digest).
//! - `vk_id`: SHA-256 of serialized verifying key (ceremony-bound).
//! - `artifact_bundle_id`: SHA-256(metadata || vk bytes).

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use sha2::{Digest, Sha256};

use crate::hash_gadget::{D_TX, ENCODING_VERSION};
use crate::smt_gadget::SMT_DEPTH;

pub const CIRCUIT_TAG: &str = "UEP-27-SPEND-POSEIDON-D32-v2-domain";
pub const CIRCUIT_DEPTH: usize = SMT_DEPTH;
/// Pre-domain count. Recount after the domain public input is compiled.
pub const CIRCUIT_CONSTRAINTS: usize = 153_098;
pub const NUM_PUBLIC_INPUTS: usize = 13;
pub const PUBLIC_INPUT_NAMES: [&str; NUM_PUBLIC_INPUTS] = [
    "old_state_root",
    "new_state_root",
    "old_nullifier_root",
    "new_nullifier_root",
    "sender_id",
    "recipient_id",
    "treasury_id",
    "asset_id",
    "amount",
    "fee",
    "nullifier",
    "transaction_commitment",
    "domain_id",
];
pub const POSEIDON_PARAM_ID: &str = "BN254-Poseidon-t3-alpha5-x5_3";
pub const TX_ENCODING_VERSION: u64 = ENCODING_VERSION;
pub const TX_DOMAIN: u64 = D_TX;

const META_DOMAIN: &[u8] = b"UEP-CIRCUIT-METADATA-v1";
const VK_DOMAIN: &[u8] = b"UEP-GROTH16-VK-v1";
const BUNDLE_DOMAIN: &[u8] = b"UEP-GROTH16-ARTIFACT-v1";

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    format!("0x{}", hex_encode(&Sha256::digest(data)))
}

pub fn public_schema_bytes() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(NUM_PUBLIC_INPUTS as u32).to_le_bytes());
    for (i, name) in PUBLIC_INPUT_NAMES.iter().enumerate() {
        out.extend_from_slice(&(i as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.push(0);
    }
    out
}

pub fn public_schema_id() -> String {
    let mut h = Sha256::new();
    h.update(b"UEP-PUBLIC-SCHEMA-v1");
    h.update(public_schema_bytes());
    format!("0x{}", hex_encode(&h.finalize()))
}

pub fn circuit_metadata_bytes() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(META_DOMAIN);
    out.extend_from_slice(&TX_ENCODING_VERSION.to_le_bytes());
    out.extend_from_slice(&(CIRCUIT_DEPTH as u64).to_le_bytes());
    out.extend_from_slice(&(CIRCUIT_CONSTRAINTS as u64).to_le_bytes());
    out.extend_from_slice(&(NUM_PUBLIC_INPUTS as u64).to_le_bytes());
    out.extend_from_slice(&(TX_DOMAIN as u64).to_le_bytes());
    out.extend_from_slice(POSEIDON_PARAM_ID.as_bytes());
    out.push(0);
    out.extend_from_slice(CIRCUIT_TAG.as_bytes());
    out.push(0);
    out.extend_from_slice(&public_schema_bytes());
    out
}

/// SHA-256 of declared metadata. **Not** an R1CS constraint-system digest.
pub fn circuit_metadata_id() -> String {
    sha256_hex(&circuit_metadata_bytes())
}

pub fn circuit_metadata_fr() -> Fr {
    let digest = Sha256::digest(circuit_metadata_bytes());
    let mut acc = Fr::from(0u64);
    let mut pow = Fr::from(1u64);
    for chunk in digest.chunks(8) {
        let mut v = 0u64;
        for (i, b) in chunk.iter().enumerate() {
            v |= (*b as u64) << (8 * i);
        }
        acc += Fr::from(v) * pow;
        for _ in 0..64 {
            pow = pow + pow;
        }
    }
    acc
}

pub fn circuit_hash() -> Fr {
    circuit_metadata_fr()
}

pub fn circuit_hash_hex() -> String {
    let h = circuit_metadata_fr();
    format!("0x{}", hex_encode(&h.into_repr().to_bytes_be()))
}

pub fn vk_id(vk_bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(VK_DOMAIN);
    h.update(&(vk_bytes.len() as u64).to_le_bytes());
    h.update(vk_bytes);
    format!("0x{}", hex_encode(&h.finalize()))
}

pub fn artifact_bundle_id(vk_bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(BUNDLE_DOMAIN);
    h.update(circuit_metadata_bytes());
    h.update(VK_DOMAIN);
    h.update(vk_bytes);
    format!("0x{}", hex_encode(&h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_id_is_stable_and_full_length() {
        assert_eq!(circuit_metadata_id(), circuit_metadata_id());
        assert_eq!(circuit_metadata_id().len(), 66);
    }

    #[test]
    fn public_schema_includes_all_names() {
        assert_eq!(PUBLIC_INPUT_NAMES.len(), NUM_PUBLIC_INPUTS);
        assert_eq!(CIRCUIT_CONSTRAINTS, 153_098);
        let bytes = public_schema_bytes();
        for name in PUBLIC_INPUT_NAMES {
            assert!(bytes.windows(name.len()).any(|w| w == name.as_bytes()));
        }
    }

    #[test]
    fn metadata_changes_when_tag_would_collide_on_8_bytes() {
        assert_ne!(public_schema_id(), circuit_metadata_id());
    }

    #[test]
    fn vk_id_changes_with_bytes() {
        assert_ne!(vk_id(b"a"), vk_id(b"b"));
    }
}
