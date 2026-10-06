# Research Vision and Publication Boundary

This project started as a research question: can separate parties agree on value, service exchange and settlement without a universal currency, without centralized payment operators and without assuming synchronous global confirmation?

The repository then grew through the following stages:

1. minimal testnet model for identities, notes, nullifiers and transaction state;
2. hardened local testnet with snapshots, signatures and replay protections;
3. Marketplace and IoT/M2M settlement flows;
4. category modules, oracle policy and settlement engine experiments;
5. public research-lab code for Rust/ZK, node and consensus experiments.

The key documentation principle is simple: research code is explicitly marked as experimental and is not treated as a production network claim.

## Publication boundary

The public repository includes:

- the reproducible testnet reference,
- signed Marketplace semantics,
- documented open issues,
- security remediation history,
- explicit lab boundaries.

The repository deliberately excludes:

- private deployment secrets,
- private production keys,
- internal workspace or private audit material,
- private infrastructure or operational credentials.

## Operating ethos

The project follows an adversarial engineering model:

- design;
- implement;
- test;
- attack;
- measure;
- correct; and
- document.

This is why the public documentation emphasizes known limitations and distinguishes the testnet core from the lab code and future research tracks.
