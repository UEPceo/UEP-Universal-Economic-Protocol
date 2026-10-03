use std::io::{self, Read};
use std::time::Instant;
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use rand::{rngs::StdRng, SeedableRng};
use uep_26_spend_circuit::circuit_id::{
    artifact_bundle_id, circuit_metadata_id, public_schema_id, vk_id, CIRCUIT_CONSTRAINTS,
    CIRCUIT_TAG, DEV_SETUP_SEED, NUM_PUBLIC_INPUTS, PUBLIC_INPUT_NAMES,
};
use uep_26_spend_circuit::groth16_spend::{
    deserialize_proof, deserialize_vk, prove, public_inputs_from_circuit, serialize_pk,
    serialize_proof, serialize_vk, setup, verify, verify_independent,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use uep_26_spend_circuit::poseidon_suite::honest_spend_fixture_poseidon;
use uep_26_spend_circuit::prove_request::{
    circuit_from_request, fr_hex, parse_canonical_fr, parse_canonical_fr_hex, PoseidonSpendRequest,
};

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn fr_to_hex(f: &Fr) -> String {
    let bytes = f.into_repr().to_bytes_be();
    hex_encode(&bytes)
}

fn fr_from_hex_or_dec(s: &str) -> Result<Fr, String> {
    parse_canonical_fr(s)
}

fn fr_from_hex(s: &str) -> Result<Fr, String> {
    parse_canonical_fr_hex(s)
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!(
            "uep-zk circuit-id|count-constraints|dev-vk|state-index|...|note-commit|low-bits|h-account|h-merkle|smt-root|smt-path"
        );
        std::process::exit(2);
    });
    match cmd.as_str() {
        "count-constraints" => {
            let c4 = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
            let cs4 = ConstraintSystem::<Fr>::new_ref();
            c4.generate_constraints(cs4.clone()).expect("d4");
            println!("d4={}", cs4.num_constraints());
            let c32 = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
            let cs32 = ConstraintSystem::<Fr>::new_ref();
            c32.generate_constraints(cs32.clone()).expect("d32");
            println!("d32={}", cs32.num_constraints());
            println!("public_inputs={NUM_PUBLIC_INPUTS}");
        }
        "circuit-id" => {
            println!("tag={CIRCUIT_TAG}");
            println!("constraints={CIRCUIT_CONSTRAINTS}");
            println!("public_inputs={NUM_PUBLIC_INPUTS}");
            println!("circuit_metadata_id={}", circuit_metadata_id());
            println!("public_schema_id={}", public_schema_id());
        }
        "public-schema" => {
            for (i, n) in PUBLIC_INPUT_NAMES.iter().enumerate() {
                println!("{i}\t{n}");
            }
            println!("public_schema_id={}", public_schema_id());
        }
        "demo-d4" | "demo-d32" => {
            let d32 = cmd == "demo-d32";
            let mut rng = StdRng::seed_from_u64(if d32 { 2026 } else { 42 });
            let t0 = Instant::now();
            let (pk, vk, publics, proof, setup_ms, prove_ms) = if d32 {
                let c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
                let publics = public_inputs_from_circuit(&c);
                let (pk, vk) = setup(c.clone(), &mut rng).unwrap();
                let setup_ms = t0.elapsed().as_millis();
                let t1 = Instant::now();
                let proof = prove(&pk, c, &mut rng).unwrap();
                (pk, vk, publics, proof, setup_ms, t1.elapsed().as_millis())
            } else {
                let c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
                let publics = public_inputs_from_circuit(&c);
                let (pk, vk) = setup(c.clone(), &mut rng).unwrap();
                let setup_ms = t0.elapsed().as_millis();
                let t1 = Instant::now();
                let proof = prove(&pk, c, &mut rng).unwrap();
                (pk, vk, publics, proof, setup_ms, t1.elapsed().as_millis())
            };
            let t2 = Instant::now();
            assert!(verify(&vk, &publics, &proof).unwrap());
            let verify_ms = t2.elapsed().as_millis();
            let vk_b = serialize_vk(&vk).unwrap();
            println!("ok=true");
            println!("setup_ms={setup_ms}");
            println!("prove_ms={prove_ms}");
            println!("verify_ms={verify_ms}");
            println!("pk_bytes={}", serialize_pk(&pk).unwrap().len());
            println!("vk_bytes={}", vk_b.len());
            println!("proof_bytes={}", serialize_proof(&proof).unwrap().len());
            println!("tag={CIRCUIT_TAG}");
            println!("vk_id={}", vk_id(&vk_b));
            println!("artifact_bundle_id={}", artifact_bundle_id(&vk_b));
        }
        "dev-vk" => {
            // Prints the development verifying key for a depth (fixed dev setup).
            let d: u32 = std::env::args().nth(2).and_then(|x| x.parse().ok()).unwrap_or(4);
            let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
            let vk_b = match d {
                4 => {
                    let c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
                    let (_pk, vk) = setup(c, &mut rng).expect("setup");
                    serialize_vk(&vk).expect("ser vk")
                }
                32 => {
                    let c = honest_spend_fixture_poseidon::<32>(1_000, 10_000);
                    let (_pk, vk) = setup(c, &mut rng).expect("setup");
                    serialize_vk(&vk).expect("ser vk")
                }
                _ => {
                    eprintln!("unsupported depth {d}; use 4 or 32");
                    std::process::exit(2);
                }
            };
            println!("depth={d}");
            println!("tag={CIRCUIT_TAG}");
            println!("keys=DEV-TEST-KEYS");
            println!("vk_id={}", vk_id(&vk_b));
            println!("vk_hex={}", hex_encode(&vk_b));
        }
        "state-index" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() != 3 {
                eprintln!("usage: uep-zk state-index <account_id> <asset_id> <depth>");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::{state_key, UepPoseidon};
            let account = fr_from_hex_or_dec(&args[0]).expect("account");
            let asset = fr_from_hex_or_dec(&args[1]).expect("asset");
            let d: usize = args[2].parse().expect("depth");
            if d == 0 || d > 64 {
                eprintln!("depth must be 1..=64");
                std::process::exit(2);
            }
            let key = state_key::<UepPoseidon>(account, asset);
            println!("state_key={}", fr_to_hex(&key));
            println!("index={}", uep_26_spend_circuit::smt_gadget::low_bits_u64(key, d));
        }
        "prove-export-d4" => {
            let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
            let c = honest_spend_fixture_poseidon::<4>(1_000, 10_000);
            let publics = public_inputs_from_circuit(&c);
            let (pk, vk) = setup(c.clone(), &mut rng).expect("setup");
            let proof = prove(&pk, c, &mut rng).expect("prove");
            assert!(verify(&vk, &publics, &proof).expect("verify"));
            let vk_b = serialize_vk(&vk).expect("ser vk");
            let proof_b = serialize_proof(&proof).expect("ser proof");
            let _ = pk;
            println!("ok=true");
            println!("depth=4");
            println!("tag={CIRCUIT_TAG}");
            println!("vk_id={}", vk_id(&vk_b));
            println!("artifact_bundle_id={}", artifact_bundle_id(&vk_b));
            println!("vk_hex={}", hex_encode(&vk_b));
            println!("proof_hex={}", hex_encode(&proof_b));
            println!("public_count={}", publics.len());
            for (i, p) in publics.iter().enumerate() {
                println!("public_{i}={}", fr_to_hex(p));
            }
        }
        "verify-hex" => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input).expect("stdin");
            let mut vk_hex = None;
            let mut proof_hex = None;
            let mut publics = vec![None; NUM_PUBLIC_INPUTS];
            for line in input.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("vk_hex=") {
                    vk_hex = Some(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("proof_hex=") {
                    proof_hex = Some(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("public_") {
                    if let Some((idx_s, val)) = rest.split_once('=') {
                        if let Ok(idx) = idx_s.parse::<usize>() {
                            if idx < NUM_PUBLIC_INPUTS {
                                publics[idx] = Some(val.to_string());
                            }
                        }
                    }
                }
            }
            let vk_b = hex_decode(&vk_hex.expect("vk_hex=")).expect("vk");
            let proof_b = hex_decode(&proof_hex.expect("proof_hex=")).expect("proof");
            let mut frs = Vec::with_capacity(NUM_PUBLIC_INPUTS);
            for (i, p) in publics.iter().enumerate() {
                let h = p.as_ref().unwrap_or_else(|| panic!("missing public_{i}"));
                frs.push(fr_from_hex(h).unwrap_or_else(|e| panic!("public_{i}: {e}")));
            }
            let _ = deserialize_vk(&vk_b).expect("deserialize vk");
            let _ = deserialize_proof(&proof_b).expect("deserialize proof");
            let ok = verify_independent(&vk_b, &frs, &proof_b).expect("verify");
            println!("ok={ok}");
            if !ok {
                std::process::exit(1);
            }
        }
        // Wallet economic JSON → Poseidon circuit → Groth16; publics bound to THIS spend.
        "prove-spend-json" => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input).expect("stdin");
            let req: PoseidonSpendRequest = match serde_json::from_str(&input) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("json error: {e}");
                    std::process::exit(2);
                }
            };
            let depth = req.depth;
            let seed = req.seed;
            // Keys come from the fixed dev setup (same VK for every request at a
            // depth, so verifiers can pin it); the request seed only drives
            // proving randomness.
            let mut setup_rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
            let mut rng = StdRng::seed_from_u64(seed);

            let mut run = |depth: u32| -> Result<(), String> {
                match depth {
                    4 | 32 => {
                        let t0 = Instant::now();
                        let (publics, vk_b, proof_b, setup_ms, prove_ms, verify_ms) = if depth == 4 {
                            let c = circuit_from_request::<4>(&req)?;
                            let publics = public_inputs_from_circuit(&c);
                            println!("leaf_sender_index={}", c.sender_index);
                            println!("leaf_sender_new={}", fr_to_hex(&c.sender_new_leaf));
                            println!("leaf_recipient_index={}", c.recipient_index);
                            println!("leaf_recipient_new={}", fr_to_hex(&c.recipient_new_leaf));
                            println!("leaf_treasury_index={}", c.treasury_index);
                            println!("leaf_treasury_new={}", fr_to_hex(&c.treasury_new_leaf));
                            println!("leaf_nullifier_index={}", c.nullifier_index);
                            println!("leaf_nullifier={}", fr_to_hex(&c.nullifier_leaf));
                            let (pk, vk) = setup(c.clone(), &mut setup_rng).map_err(|e| format!("{e:?}"))?;
                            let setup_ms = t0.elapsed().as_millis();
                            let t1 = Instant::now();
                            let proof = prove(&pk, c, &mut rng).map_err(|e| format!("{e:?}"))?;
                            let prove_ms = t1.elapsed().as_millis();
                            let t2 = Instant::now();
                            let ok = verify(&vk, &publics, &proof).map_err(|e| format!("{e:?}"))?;
                            let verify_ms = t2.elapsed().as_millis();
                            if !ok {
                                return Err("verify returned false".into());
                            }
                            let vk_b = serialize_vk(&vk).map_err(|e| format!("{e}"))?;
                            let proof_b = serialize_proof(&proof).map_err(|e| format!("{e}"))?;
                            let _ = pk;
                            (publics, vk_b, proof_b, setup_ms, prove_ms, verify_ms)
                        } else {
                            let c = circuit_from_request::<32>(&req)?;
                            let publics = public_inputs_from_circuit(&c);
                            println!("leaf_sender_index={}", c.sender_index);
                            println!("leaf_sender_new={}", fr_to_hex(&c.sender_new_leaf));
                            println!("leaf_recipient_index={}", c.recipient_index);
                            println!("leaf_recipient_new={}", fr_to_hex(&c.recipient_new_leaf));
                            println!("leaf_treasury_index={}", c.treasury_index);
                            println!("leaf_treasury_new={}", fr_to_hex(&c.treasury_new_leaf));
                            println!("leaf_nullifier_index={}", c.nullifier_index);
                            println!("leaf_nullifier={}", fr_to_hex(&c.nullifier_leaf));
                            let (pk, vk) = setup(c.clone(), &mut setup_rng).map_err(|e| format!("{e:?}"))?;
                            let setup_ms = t0.elapsed().as_millis();
                            let t1 = Instant::now();
                            let proof = prove(&pk, c, &mut rng).map_err(|e| format!("{e:?}"))?;
                            let prove_ms = t1.elapsed().as_millis();
                            let t2 = Instant::now();
                            let ok = verify(&vk, &publics, &proof).map_err(|e| format!("{e:?}"))?;
                            let verify_ms = t2.elapsed().as_millis();
                            if !ok {
                                return Err("verify returned false".into());
                            }
                            let vk_b = serialize_vk(&vk).map_err(|e| format!("{e}"))?;
                            let proof_b = serialize_proof(&proof).map_err(|e| format!("{e}"))?;
                            let _ = pk;
                            (publics, vk_b, proof_b, setup_ms, prove_ms, verify_ms)
                        };
                        println!("ok=true");
                        println!("depth={depth}");
                        println!("network_profile={}", req.network_profile);
                        println!("keys=DEV-TEST-KEYS");
                        println!("setup_ms={setup_ms}");
                        println!("prove_ms={prove_ms}");
                        println!("verify_ms={verify_ms}");
                        println!("tag={CIRCUIT_TAG}");
                        println!("vk_id={}", vk_id(&vk_b));
                        println!("vk_hex={}", hex_encode(&vk_b));
                        println!("proof_hex={}", hex_encode(&proof_b));
                        for (i, p) in publics.iter().enumerate() {
                            println!("public_{i}={}", fr_to_hex(p));
                        }
                        println!("bound_sender_id={}", fr_hex(&publics[4]));
                        println!("bound_recipient_id={}", fr_hex(&publics[5]));
                        println!("bound_treasury_id={}", fr_hex(&publics[6]));
                        println!("bound_asset_id={}", fr_hex(&publics[7]));
                        println!("bound_amount={}", fr_hex(&publics[8]));
                        println!("bound_fee={}", fr_hex(&publics[9]));
                        println!("bound_nullifier={}", fr_hex(&publics[10]));
                        println!("bound_tx_commitment={}", fr_hex(&publics[11]));
                        println!("old_state_root={}", fr_to_hex(&publics[0]));
                        println!("new_state_root={}", fr_to_hex(&publics[1]));
                        println!("old_nullifier_root={}", fr_to_hex(&publics[2]));
                        println!("new_nullifier_root={}", fr_to_hex(&publics[3]));
                        Ok(())
                    }
                    d => Err(format!("unsupported depth {d}; use 4 or 32")),
                }
            };

            if let Err(e) = run(depth) {
                eprintln!("error={e}");
                println!("ok=false");
                println!("error={e}");
                std::process::exit(1);
            }
        }
        "h-account" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() != 2 {
                eprintln!("usage: uep-zk h-account <secret> <salt>");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::{h_account, UepPoseidon};
            let secret = fr_from_hex_or_dec(&args[0]).expect("secret");
            let salt = fr_from_hex_or_dec(&args[1]).expect("salt");
            let id = h_account::<UepPoseidon>(secret, salt);
            println!("account_id={}", fr_to_hex(&id));
            let idx4 = uep_26_spend_circuit::smt_gadget::low_bits_u64(id, 4);
            let idx32 = uep_26_spend_circuit::smt_gadget::low_bits_u64(id, 32);
            println!("index_d4={idx4}");
            println!("index_d32={idx32}");
        }

        "note-commit" => {
            // args: owner asset amount blinding  (decimal or 0x hex)
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() != 4 {
                eprintln!("usage: uep-zk note-commit <owner> <asset> <amount> <blinding>");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::{note_commitment, UepPoseidon};
            use uep_26_spend_circuit::prove_request::fr_hex;
            let owner = fr_from_hex_or_dec(&args[0]).expect("owner");
            let asset = fr_from_hex_or_dec(&args[1]).expect("asset");
            let amount = fr_from_hex_or_dec(&args[2]).expect("amount");
            // Amounts are u64 in the smallest unit: reject anything wider (no truncation).
            if amount.into_repr().to_bytes_be()[..24].iter().any(|b| *b != 0) {
                eprintln!("amount exceeds u64");
                std::process::exit(2);
            }
            let blinding = fr_from_hex_or_dec(&args[3]).expect("blinding");
            let leaf = note_commitment::<UepPoseidon>(owner, asset, amount, blinding);
            println!("leaf={}", fr_to_hex(&leaf));
        }
        "low-bits" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() != 2 {
                eprintln!("usage: uep-zk low-bits <value> <depth>");
                std::process::exit(2);
            }
            let v = fr_from_hex_or_dec(&args[0]).expect("value");
            let d: usize = args[1].parse().expect("depth");
            let idx = uep_26_spend_circuit::smt_gadget::low_bits_u64(v, d);
            println!("index={idx}");
        }

        "h-merkle" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() != 2 {
                eprintln!("usage: uep-zk h-merkle <left> <right>");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::{h_merkle, UepPoseidon};
            let left = fr_from_hex_or_dec(&args[0]).expect("left");
            let right = fr_from_hex_or_dec(&args[1]).expect("right");
            let out = h_merkle::<UepPoseidon>(left, right);
            println!("hash={}", fr_to_hex(&out));
        }

        // leaves: depth then pairs index:leaf_hex (index decimal, leaf 64-hex)
        // example: uep-zk smt-root 8 5:0011b4... 12:2f85ae...
        "smt-root" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() < 1 {
                eprintln!("usage: uep-zk smt-root <depth> [index:leaf_hex ...]");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::UepPoseidon;
            use uep_26_spend_circuit::native_smt::NativeSmt;
            let depth: usize = args[0].parse().expect("depth");
            // Support fixed depths used in tests/prod
            macro_rules! run_smt {
                ($d:expr) => {{
                    let mut tree = NativeSmt::<UepPoseidon, $d>::new();
                    for pair in args.iter().skip(1) {
                        let (i, l) = pair.split_once(':').expect("index:leaf");
                        let idx: u64 = i.parse().expect("index");
                        let leaf = fr_from_hex_or_dec(l).expect("leaf");
                        tree.set(idx, leaf);
                    }
                    println!("depth={}", $d);
                    println!("root={}", fr_to_hex(&tree.root()));
                }};
            }
            match depth {
                4 => run_smt!(4),
                8 => run_smt!(8),
                16 => run_smt!(16),
                32 => run_smt!(32),
                _ => {
                    eprintln!("smt-root supports depth 4|8|16|32 only");
                    std::process::exit(2);
                }
            }
        }

        // smt-path <depth> <focus_index> [index:leaf ...]
        "smt-path" => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if args.len() < 2 {
                eprintln!("usage: uep-zk smt-path <depth> <focus_index> [index:leaf_hex ...]");
                std::process::exit(2);
            }
            use uep_26_spend_circuit::hash_gadget::UepPoseidon;
            use uep_26_spend_circuit::native_smt::NativeSmt;
            let depth: usize = args[0].parse().expect("depth");
            let focus: u64 = args[1].parse().expect("focus_index");
            macro_rules! run_path {
                ($d:expr) => {{
                    let mut tree = NativeSmt::<UepPoseidon, $d>::new();
                    for pair in args.iter().skip(2) {
                        let (i, l) = pair.split_once(':').expect("index:leaf");
                        let idx: u64 = i.parse().expect("index");
                        let leaf = fr_from_hex_or_dec(l).expect("leaf");
                        tree.set(idx, leaf);
                    }
                    let (sibs, bits) = tree.path(focus);
                    let leaf = tree.get_leaf(focus);
                    println!("depth={}", $d);
                    println!("index={focus}");
                    println!("leaf={}", fr_to_hex(&leaf));
                    println!("root={}", fr_to_hex(&tree.root()));
                    println!(
                        "siblings={}",
                        sibs.iter().map(|s| fr_to_hex(s)).collect::<Vec<_>>().join(",")
                    );
                    println!(
                        "index_bits={}",
                        bits.iter().map(|b| if *b { "1" } else { "0" }).collect::<String>()
                    );
                }};
            }
            match depth {
                4 => run_path!(4),
                8 => run_path!(8),
                16 => run_path!(16),
                32 => run_path!(32),
                _ => {
                    eprintln!("smt-path supports depth 4|8|16|32 only");
                    std::process::exit(2);
                }
            }
        }

        _ => {
            eprintln!("unknown command");
            std::process::exit(2);
        }
    }
}
