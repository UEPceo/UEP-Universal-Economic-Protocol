/**
 * BIP-39 English mnemonic. Status: IMPLEMENTED / TESTED
 * Used as the recovery secret of the wallet. Never logged, never sent.
 */
import { BIP39_ENGLISH } from "./bip39-english.ts";
import { pbkdf2, sha256 } from "./kdf.ts";

const te = new TextEncoder();

function bytesToBits(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
}

export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) {
    throw new Error("BIP39 entropy must be 128–256 bits");
  }
  const hash = await sha256(entropy);
  const csLen = entropy.length / 4;
  const bits = bytesToBits(entropy) + bytesToBits(hash).slice(0, csLen);
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    const idx = parseInt(bits.slice(i, i + 11), 2);
    const w = BIP39_ENGLISH[idx];
    if (!w) throw new Error("BIP39 word missing");
    words.push(w);
  }
  return words.join(" ");
}

export async function generateMnemonic(strength: 128 | 256 = 128): Promise<string> {
  const entropy = crypto.getRandomValues(new Uint8Array(strength / 8));
  return entropyToMnemonic(entropy);
}

export async function mnemonicToEntropy(mnemonic: string): Promise<Uint8Array> {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error("Recovery phrase must be 12, 15, 18, 21 or 24 words");
  }
  const bits = words
    .map((w) => {
      const idx = BIP39_ENGLISH.indexOf(w);
      if (idx < 0) throw new Error(`Unknown word: ${w}`);
      return idx.toString(2).padStart(11, "0");
    })
    .join("");
  const entLen = (bits.length * 32) / 33;
  const entBits = bits.slice(0, entLen);
  const csBits = bits.slice(entLen);
  const entropy = new Uint8Array(entLen / 8);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  }
  const hash = await sha256(entropy);
  const expect = bytesToBits(hash).slice(0, entropy.length / 4);
  if (csBits !== expect) throw new Error("Invalid recovery phrase checksum");
  return entropy;
}

export async function mnemonicToSeed(mnemonic: string, passphrase = ""): Promise<Uint8Array> {
  await mnemonicToEntropy(mnemonic);
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  return pbkdf2(te.encode(normalized), te.encode("mnemonic" + passphrase), 2048, 64, "SHA-512");
}

export function validateWord(word: string): boolean {
  return BIP39_ENGLISH.includes(word.trim().toLowerCase());
}
