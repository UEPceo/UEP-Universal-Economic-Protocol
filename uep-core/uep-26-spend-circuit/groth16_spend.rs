//! Groth16 for SpendCircuit (UEP-27.2: serialization + independent verify).

use ark_bn254::{Bn254, Fr};
use ark_groth16::{Groth16, Proof, ProvingKey, VerifyingKey};
use ark_relations::r1cs::ConstraintSynthesizer;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::{rngs::StdRng, SeedableRng};

use crate::circuit_id::{CIRCUIT_CONSTRAINTS, CIRCUIT_TAG, NUM_PUBLIC_INPUTS, PUBLIC_INPUT_NAMES};
use crate::spend_circuit::SpendCircuit;

pub fn public_inputs_from_circuit<const D: usize>(c: &SpendCircuit<D>) -> Vec<Fr> {
    vec![
        c.old_state_root,
        c.new_state_root,
        c.old_nullifier_root,
        c.new_nullifier_root,
        c.sender_id,
        c.recipient_id,
        c.treasury_id,
        c.asset_id,
        c.amount,
        c.fee,
        c.nullifier,
        c.transaction_commitment,
        c.domain_id,
    ]
}

pub type SpendProvingKey = ProvingKey<Bn254>;
pub type SpendVerifyingKey = VerifyingKey<Bn254>;
pub type SpendProof = Proof<Bn254>;

pub fn setup<const D: usize>(
    circuit: SpendCircuit<D>,
    rng: &mut StdRng,
) -> Result<(SpendProvingKey, SpendVerifyingKey), ark_relations::r1cs::SynthesisError> {
    Groth16::<Bn254>::circuit_specific_setup(circuit, rng)
}

pub fn prove<const D: usize>(
    pk: &SpendProvingKey,
    circuit: SpendCircuit<D>,
    rng: &mut StdRng,
) -> Result<SpendProof, ark_relations::r1cs::SynthesisError> {
    Groth16::<Bn254>::prove(pk, circuit, rng)
}

pub fn verify(
    vk: &SpendVerifyingKey,
    public_inputs: &[Fr],
    proof: &SpendProof,
) -> Result<bool, ark_relations::r1cs::SynthesisError> {
    Groth16::<Bn254>::verify(vk, public_inputs, proof)
}

pub fn prove_and_verify<const D: usize>(
    circuit: SpendCircuit<D>,
    seed: u64,
) -> Result<bool, ark_relations::r1cs::SynthesisError> {
    let mut rng = StdRng::seed_from_u64(seed);
    let publics = public_inputs_from_circuit(&circuit);
    let (pk, vk) = setup(circuit.clone(), &mut rng)?;
    let proof = prove(&pk, circuit, &mut rng)?;
    verify(&vk, &publics, &proof)
}

pub fn serialize_vk(vk: &SpendVerifyingKey) -> Result<Vec<u8>, ark_serialize::SerializationError> {
    let mut buf = Vec::new();
    vk.serialize(&mut buf)?;
    Ok(buf)
}
pub fn deserialize_vk(bytes: &[u8]) -> Result<SpendVerifyingKey, ark_serialize::SerializationError> {
    SpendVerifyingKey::deserialize(bytes)
}
pub fn serialize_pk(pk: &SpendProvingKey) -> Result<Vec<u8>, ark_serialize::SerializationError> {
    let mut buf = Vec::new();
    pk.serialize(&mut buf)?;
    Ok(buf)
}
pub fn deserialize_pk(bytes: &[u8]) -> Result<SpendProvingKey, ark_serialize::SerializationError> {
    SpendProvingKey::deserialize(bytes)
}
pub fn serialize_proof(proof: &SpendProof) -> Result<Vec<u8>, ark_serialize::SerializationError> {
    let mut buf = Vec::new();
    proof.serialize(&mut buf)?;
    Ok(buf)
}
pub fn deserialize_proof(bytes: &[u8]) -> Result<SpendProof, ark_serialize::SerializationError> {
    SpendProof::deserialize(bytes)
}

pub fn verify_independent(
    vk_bytes: &[u8],
    public_inputs: &[Fr],
    proof_bytes: &[u8],
) -> Result<bool, Box<dyn std::error::Error>> {
    let vk = deserialize_vk(vk_bytes)?;
    let proof = deserialize_proof(proof_bytes)?;
    Ok(verify(&vk, public_inputs, &proof)?)
}

pub fn serialize_public_inputs(inputs: &[Fr]) -> Result<Vec<u8>, ark_serialize::SerializationError> {
    if inputs.len() != NUM_PUBLIC_INPUTS {
        return Err(ark_serialize::SerializationError::UnexpectedFlags);
    }
    let mut buf = Vec::new();
    (NUM_PUBLIC_INPUTS as u64).serialize(&mut buf)?;
    for x in inputs {
        x.serialize(&mut buf)?;
    }
    Ok(buf)
}

pub fn deserialize_public_inputs(bytes: &[u8]) -> Result<Vec<Fr>, ark_serialize::SerializationError> {
    let mut slice = bytes;
    let n = u64::deserialize(&mut slice)? as usize;
    if n != NUM_PUBLIC_INPUTS {
        return Err(ark_serialize::SerializationError::UnexpectedFlags);
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(Fr::deserialize(&mut slice)?);
    }
    if !slice.is_empty() {
        return Err(ark_serialize::SerializationError::UnexpectedFlags);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::circuit_id::{
        artifact_bundle_id, circuit_metadata_id, public_schema_id, vk_id, CIRCUIT_DEPTH,
    };
    use crate::poseidon_suite::honest_spend_fixture_poseidon;
    use crate::spend_circuit::honest_spend_fixture_structural;
    use std::time::Instant;

    #[test]
    fn groth16_structural_d3_round_trip() {
        assert!(prove_and_verify(honest_spend_fixture_structural::<3>(1_000, 10_000), 42).unwrap());
    }

    #[test]
    fn groth16_structural_d3_rejects_tampered_public() {
        let circuit = honest_spend_fixture_structural::<3>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(7);
        let mut publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        publics[8] = publics[8] + Fr::from(1u64);
        assert!(!verify(&vk, &publics, &proof).unwrap());
    }

    #[test]
    fn groth16_poseidon_d4_round_trip() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(99);
        let publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        assert!(verify(&vk, &publics, &proof).unwrap());
    }

    #[test]
    fn groth16_poseidon_d4_rejects_tampered_commitment() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(11);
        let mut publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        let last = publics.len() - 1;
        publics[last] = publics[last] + Fr::from(1u64);
        assert!(!verify(&vk, &publics, &proof).unwrap());
    }

    #[test]
    fn groth16_poseidon_d32_round_trip() {
        let circuit = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(2026);
        let publics = public_inputs_from_circuit(&circuit);
        let t0 = Instant::now();
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let setup_ms = t0.elapsed().as_millis();
        let t1 = Instant::now();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        let prove_ms = t1.elapsed().as_millis();
        let t2 = Instant::now();
        assert!(verify(&vk, &publics, &proof).unwrap());
        let verify_ms = t2.elapsed().as_millis();
        eprintln!(
            "D=32 BENCH setup_ms={setup_ms} prove_ms={prove_ms} verify_ms={verify_ms} \
             pk={} vk={} proof={} tag={CIRCUIT_TAG} constraints={CIRCUIT_CONSTRAINTS}",
            serialize_pk(&pk).unwrap().len(),
            serialize_vk(&vk).unwrap().len(),
            serialize_proof(&proof).unwrap().len()
        );
    }

    #[test]
    fn groth16_poseidon_d32_rejects_tampered_nullifier() {
        let circuit = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(2027);
        let mut publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        publics[10] = publics[10] + Fr::from(1u64);
        assert!(!verify(&vk, &publics, &proof).unwrap());
    }

    #[test]
    fn independent_verifier_d4_round_trip() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(33);
        let publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        let vk_bytes = serialize_vk(&vk).unwrap();
        let proof_bytes = serialize_proof(&proof).unwrap();
        let pub_bytes = serialize_public_inputs(&publics).unwrap();
        let publics2 = deserialize_public_inputs(&pub_bytes).unwrap();
        assert_eq!(publics, publics2);
        assert!(verify_independent(&vk_bytes, &publics2, &proof_bytes).unwrap());
    }

    #[test]
    fn key_reload_prove_verify_d4() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(44);
        let publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let pk2 = deserialize_pk(&serialize_pk(&pk).unwrap()).unwrap();
        let vk2 = deserialize_vk(&serialize_vk(&vk).unwrap()).unwrap();
        let proof = prove(&pk2, circuit, &mut rng).unwrap();
        assert!(verify(&vk2, &publics, &proof).unwrap());
    }

    #[test]
    fn all_twelve_public_inputs_binding_d4() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(55);
        let publics = public_inputs_from_circuit(&circuit);
        let (pk, vk) = setup(circuit.clone(), &mut rng).unwrap();
        let proof = prove(&pk, circuit, &mut rng).unwrap();
        assert!(verify(&vk, &publics, &proof).unwrap());
        for i in 0..NUM_PUBLIC_INPUTS {
            let mut tampered = publics.clone();
            tampered[i] = tampered[i] + Fr::from(1u64);
            assert!(
                !verify(&vk, &tampered, &proof).unwrap(),
                "tamper {} ({})",
                i,
                PUBLIC_INPUT_NAMES[i]
            );
        }
    }


    #[test]
    fn strict_public_inputs_reject_wrong_count() {
        assert!(serialize_public_inputs(&[Fr::from(1u64)]).is_err());
        let thirteen = vec![Fr::from(0u64); 13];
        let bytes = serialize_public_inputs(&thirteen).unwrap();
        let mut bad = bytes.clone();
        bad.push(0xff);
        assert!(deserialize_public_inputs(&bad).is_err());
        assert_eq!(deserialize_public_inputs(&bytes).unwrap().len(), 13);
    }

    #[test]
    fn artifact_identity_from_vk_d4() {
        let circuit = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
        let mut rng = StdRng::seed_from_u64(77);
        let (_pk, vk) = setup(circuit, &mut rng).unwrap();
        let vk_bytes = serialize_vk(&vk).unwrap();
        let id = vk_id(&vk_bytes);
        let bundle = artifact_bundle_id(&vk_bytes);
        assert_eq!(id.len(), 66);
        assert_ne!(id, bundle);
        eprintln!("circuit_metadata_id={}", circuit_metadata_id());
        eprintln!("public_schema_id={}", public_schema_id());
        eprintln!("vk_id={id}");
        eprintln!("artifact_bundle_id={bundle}");
    }

    #[test]
    fn circuit_identity_constants() {
        assert_eq!(CIRCUIT_DEPTH, 32);
        assert_eq!(CIRCUIT_CONSTRAINTS, 155_393);
        assert_eq!(NUM_PUBLIC_INPUTS, 13);
        assert_eq!(CIRCUIT_CONSTRAINTS, 155_393);
        let _ = circuit_metadata_id();
    }
}
