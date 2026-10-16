# Governance key ceremony: procedure and tooling (0.5.84, item 4)

Status: **prepared, not performed.** No governance key exists. The ceremony needs the maintainer and the participants; nothing in this repository generates or stores a private key.

## Purpose

The governance key set (public keys + threshold M of N) signs the asset-registry manifest chain (`src/core/asset-registry.ts`, `src/node/asset-registry-store.ts`). A network whose policy requires the registry pins this key set (`NetworkRegistryPolicy.governance`). Mainnet cannot resolve its registry policy without it (`PRODUCTION_CONDITIONS_UNMET`, `src/network/production-conditions.ts`).

## Decisions the maintainer must take (open)

| Decision | Field in `ceremony.json` → `decisions` | Notes |
|---|---|---|
| Who the participants are (people / organisations) | `participants` | N ≥ 3 for mainnet |
| Threshold M of N | `threshold` | mainnet: strict majority (2M > N) enforced by the tool |
| Key custody | `custody` | hardware token or offline machine per participant; no shared custody |
| Where and how (in person / remote, air-gapped devices) | `venue` | |
| Witnesses / recording of the transcript | `witnesses` | |
| Rotation policy (when, how many signatures) | `rotationPolicy` | |
| Loss or compromise procedure | `lossProcedure` | revocation via a manifest signed by the remaining quorum |
| From which height the key set governs each network | `effectiveHeight` | ties to `config/production-conditions.json` |

`node scripts/governance-ceremony.mjs plan config/governance-ceremony.example.json` lists every open decision.

## Procedure

1. **Prepare.** Copy `config/governance-ceremony.example.json`, fill `networkId`, `networkKind`, `ceremonyId`, `threshold`, `participants` and all `decisions`. `plan` must report no problems and no open decisions.
2. **Distribute** the ceremony file to every participant (signed commit or out-of-band hash check).
3. **Key generation (each participant, alone, offline).** Generate an Ed25519 key on the participant's own device (for example `openssl genpkey -algorithm ed25519`, or a hardware token). The private key never leaves that device and is never sent to anyone, including the maintainer or this tooling.
4. **Proof of possession.** `node scripts/governance-ceremony.mjs pop-message ceremony.json <participantId>` prints the exact message. The participant signs it offline and sends only `{ participantId, publicKeyHex, popSignatureHex }`.
5. **Verify.** `node scripts/governance-ceremony.mjs verify ceremony.json submissions.json --out governance.json` checks every signature, rejects duplicates, reused keys and missing participants, and outputs the KeySet `{ keys, threshold }` plus a transcript hash.
6. **Confirm out of band.** Each participant checks the transcript hash.
7. **Pin.** Commit `governance.json` (public keys only) into the network registry policy, then sign manifest version 1 with M participants (each signs on their own device).
8. **Record.** Store the transcript (public) under `docs/governance/` with the date and the witnesses.

## Tooling guarantees

- `scripts/governance-ceremony.mjs` handles public keys and signatures only; it refuses `--generate`, `--keygen`, `--private*` flags.
- `self-test` (`npm run check:ceremony-tool`, part of `test:core`) creates throwaway keys in memory, never writes or prints them, and checks: valid PoP accepted, forged PoP rejected, reused key rejected, open decisions listed.
- Tests elsewhere use keys created in memory and marked TEST-ONLY. No key is committed.
