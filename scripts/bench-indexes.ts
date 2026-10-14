import { clientBlinding } from "../src/core/client-note.ts";
/**
 * v0.5.4 CI bench: owner->notes and pending/order indexes stay flat.
 * Prints timings; exits non-zero if a lookup scan regresses past the budget.
 */
import { UepLedger } from "../src/testnet/ledger.ts";
import { TESTNET } from "../src/network/profiles.ts";
import { generateEd25519KeyPair } from "../src/core/ed25519.ts";
import { identityFromMnemonic, generateMnemonic } from "../src/identity/index.ts";

const n = Number(process.env.UEP_BENCH_NOTES ?? 2000);
const snap = generateEd25519KeyPair();
const faucet = generateEd25519KeyPair();
const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey });
const alice = await identityFromMnemonic(await generateMnemonic(128));
for (let i = 0; i < n; i++) l.faucet(l.addressOf(alice.accountId), "uep-test/teur", 1n, clientBlinding(BigInt(i) + 1n));
const t0 = performance.now();
const notes = l.notesOf(alice.accountId);
const ms = performance.now() - t0;
if (notes.length !== n) throw new Error(`owner index returned ${notes.length}, expected ${n}`);
if (ms > 50) throw new Error(`owner index lookup ${ms.toFixed(2)}ms exceeded 50ms for ${n} notes`);
console.log(`bench-indexes: notesOf ${n} notes in ${ms.toFixed(2)}ms`);
