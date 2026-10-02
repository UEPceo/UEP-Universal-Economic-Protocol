/**
 * Bech32m (BIP-350) — minimal pure implementation for UEP-ADDR-002.
 * Charset and polymod match Bitcoin / BIP-350.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_MAP: Record<string, number> = Object.fromEntries(
  [...CHARSET].map((c, i) => [c, i]),
);

const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

/** Bech32m constant (BIP-350). */
const BECH32M_CONST = 0x2bc830a3;

export function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || (acc << (toBits - bits)) & maxv) {
    return null;
  }
  return ret;
}

export function bech32mEncode(hrp: string, data: number[]): string {
  const hrpLower = hrp.toLowerCase();
  const values = [...hrpExpand(hrpLower), ...data];
  const checksumValues = [...values, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumValues) ^ BECH32M_CONST;
  const checksum = [0, 0, 0, 0, 0, 0].map((_, i) => (mod >> (5 * (5 - i))) & 31);
  return hrpLower + "1" + [...data, ...checksum].map((d) => CHARSET[d]!).join("");
}

export function bech32mDecode(str: string): { hrp: string; data: number[] } | null {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length || s.length > 90) return null;
  const hrp = s.slice(0, pos);
  const dataPart = s.slice(pos + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const v = CHARSET_MAP[c];
    if (v === undefined) return null;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}
