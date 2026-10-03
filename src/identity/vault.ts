/**
 * Encrypted vault at rest. Secrets never leave this module in plaintext except
 * into the in-memory session after a successful PIN unlock.
 *
 * Status: IMPLEMENTED (Web Crypto AES-GCM). Android Keystore: see android/.
 */
import { aesGcmDecrypt, aesGcmEncrypt, fromB64, pbkdf2, PIN_ITERATIONS, toB64, deriveIdentity, type IdentitySecrets } from "./kdf.ts";
import { mnemonicToSeed } from "./mnemonic.ts";
import { hAccount } from "../core/hash.ts";

const VAULT_KEY = "uep.wallet.vault.v1";

export type VaultRecord = {
  version: 1;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  accountId: string;
  createdAt: number;
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function loadVault(): VaultRecord | null {
  const s = storage()?.getItem(VAULT_KEY);
  if (!s) return null;
  try {
    const v = JSON.parse(s) as VaultRecord;
    if (v.version !== 1 || !v.ciphertext) return null;
    return v;
  } catch {
    return null;
  }
}

export function vaultExists(): boolean {
  return loadVault() !== null;
}

export function clearVault(): void {
  storage()?.removeItem(VAULT_KEY);
}

async function wrap(pin: string, secrets: IdentitySecrets): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2(new TextEncoder().encode(pin), salt, PIN_ITERATIONS, 32, "SHA-256");
  const payload = new TextEncoder().encode(
    JSON.stringify({
      mnemonic: secrets.mnemonic,
      seed: toB64(secrets.seed),
    }),
  );
  const { iv, ciphertext } = await aesGcmEncrypt(key, payload);
  return {
    version: 1,
    kdf: "PBKDF2-SHA-256",
    iterations: PIN_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
    accountId: secrets.accountId.toHex(),
    createdAt: Date.now(),
  };
}

export async function saveVault(pin: string, secrets: IdentitySecrets): Promise<VaultRecord> {
  const rec = await wrap(pin, secrets);
  storage()?.setItem(VAULT_KEY, JSON.stringify(rec));
  return rec;
}

export async function unlockVault(pin: string): Promise<IdentitySecrets> {
  const rec = loadVault();
  if (!rec) throw new Error("No wallet on this device");
  const key = await pbkdf2(
    new TextEncoder().encode(pin),
    fromB64(rec.salt),
    rec.iterations,
    32,
    "SHA-256",
  );
  let pt: Uint8Array;
  try {
    pt = await aesGcmDecrypt(key, fromB64(rec.iv), fromB64(rec.ciphertext));
  } catch {
    throw new Error("Incorrect PIN");
  }
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { mnemonic: string; seed: string };
  const secrets = await deriveIdentity(fromB64(parsed.seed), parsed.mnemonic);
  // v0.5.0: a vault created v0.4.5 to v0.5.0 stored the v2 id of the same key;
  // it keeps working as that account (withAccountIdV2), new vaults store v3.
  if (secrets.accountIdV2 && secrets.accountIdV2.toHex() === rec.accountId) return { ...secrets, accountId: secrets.accountIdV2 };
  if (secrets.accountId.toHex() !== rec.accountId) {
    // v0.4.5: account ids are key-derived (UEP-ADDR-002); vaults created earlier
    // stored the legacy H(secret, salt) id. The mnemonic still restores the
    // wallet, but its testnet account and address are new.
    if (rec.accountId === hAccount(secrets.secret, secrets.salt).toHex()) throw new Error("LEGACY_VAULT: created before v0.4.5; re-import the mnemonic to derive the new key-derived account");
    throw new Error("Vault integrity check failed");
  }
  return secrets;
}

export async function changePin(oldPin: string, newPin: string): Promise<void> {
  const secrets = await unlockVault(oldPin);
  await saveVault(newPin, secrets);
}

export async function identityFromMnemonic(mnemonic: string, passphrase = ""): Promise<IdentitySecrets> {
  const seed = await mnemonicToSeed(mnemonic, passphrase);
  return deriveIdentity(seed, mnemonic.trim().toLowerCase().split(/\s+/).join(" "));
}
