# Ceremony rehearsal — not a ceremony

The lab proving key is produced by circuit_specific_setup with a seeded RNG.
Seed 42 is the default lab setup. Seed 2026 is the D=32 fixture seed.
The setup trapdoor remains inside the proving key. It is not extracted and not destroyed.

Nodes pin the verifying key. A proof whose VK does not match the pin is rejected.
That stops a proof from another seed. It does not create Groth16 soundness.
A testnet remains blocked until a ceremony destroys the trapdoor.
