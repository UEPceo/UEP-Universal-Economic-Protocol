/**
 * BN254 scalar field (Fr) used by UEP-21/25.
 * Status: IMPLEMENTED / TESTED against ark-bn254 0.4 vectors for the UEP-25 hash.
 */
export const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const MOD = BN254_FR_MODULUS;

function norm(n: bigint): bigint {
  const r = n % MOD;
  return r >= 0n ? r : r + MOD;
}

export class Fr {
  readonly n: bigint;

  constructor(n: bigint | number | string | Fr) {
    if (n instanceof Fr) {
      this.n = n.n;
      return;
    }
    if (typeof n === "string") {
      const s = n.startsWith("0x") || n.startsWith("0X") ? n.slice(2) : n;
      this.n = norm(BigInt("0x" + s));
      return;
    }
    this.n = norm(BigInt(n));
  }

  static zero(): Fr {
    return new Fr(0n);
  }

  static one(): Fr {
    return new Fr(1n);
  }

  static from(n: bigint | number | string | Fr): Fr {
    return n instanceof Fr ? n : new Fr(n);
  }

  static fromBytesBE(bytes: Uint8Array): Fr {
    let x = 0n;
    for (const b of bytes) x = (x << 8n) + BigInt(b);
    return new Fr(x);
  }

  /**
   * FINDING-05: pack into < 254 bits before reduction to avoid
   * full 256-bit SHA-256 values wrapping the BN254 modulus.
   * Does not replace fromBytesBE (golden vectors).
   */
  static fromBytesBE254(bytes: Uint8Array): Fr {
    const buf = bytes.length > 31 ? bytes.subarray(0, 31) : bytes;
    let x = 0n;
    for (const b of buf) x = (x << 8n) + BigInt(b);
    return new Fr(x);
  }

  add(o: Fr): Fr {
    return new Fr(this.n + o.n);
  }

  sub(o: Fr): Fr {
    return new Fr(this.n - o.n);
  }

  mul(o: Fr): Fr {
    return new Fr(this.n * o.n);
  }

  eq(o: Fr): boolean {
    return this.n === o.n;
  }

  isZero(): boolean {
    return this.n === 0n;
  }

  toHex(): string {
    return this.n.toString(16).padStart(64, "0");
  }

  toPrefixedHex(): string {
    return "0x" + this.toHex();
  }

  toBytesBE(): Uint8Array {
    const hex = this.toHex();
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  /** Low `bits` bits, used as a Sparse Merkle Tree index. */
  lowBits(bits: number): bigint {
    const mask = (1n << BigInt(bits)) - 1n;
    return this.n & mask;
  }

  toString(): string {
    return this.toPrefixedHex();
  }

  toJSON(): string {
    return this.toHex();
  }
}

export function frFromUtf8(s: string): Fr {
  return Fr.fromBytesBE(new TextEncoder().encode(s));
}
