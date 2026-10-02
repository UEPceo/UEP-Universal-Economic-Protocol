/**
 * Encrypted vault at rest. Secrets never leave this module in plaintext except
 * into the in-memory session after a successful PIN unlock.
 *
 * Status: IMPLEMENTED (Web Crypto AES-GCM). Android Keystore: see android/.
 */
import { aesGcmDecrypt, aesGcmEncrypt, fromB64, pbkdf2, PIN_ITERATIONS, toB64, deriveIdentity, type IdentitySecrets } from "./kdf.ts";
import { mnemonicToSeed } from "./mnemonic.ts";

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
  if (secrets.accountId.toHex() !== rec.accountId) throw new Error("Vault integrity check failed");
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
