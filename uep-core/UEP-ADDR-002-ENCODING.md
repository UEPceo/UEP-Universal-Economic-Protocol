# UEP-ADDR-002 — Address String Encoding (frozen for v1)

**Status:** 🟢 SPEC + TS reference codec  
**Depends on:** UEP-ADDR-001  
**Date:** 2026-09-27  

## 1. Choice: Bech32m (BIP-350)

| Option | Decision |
|---|---|
| Bech32 (BIP-173) | ❌ weaker against insertion of `p` |
| **Bech32m (BIP-350)** | ✅ chosen |
| Base58Check | ❌ no HRP, weaker network segregation |
| Raw hex `uep:net:hex` | ❌ provisional only (legacy lab) |

Checksum is **string integrity**, not a substitute for Poseidon `address_id` binding.

## 2. Human-readable part (HRP)

```
HRP = "uep" || network_suffix
```

| `network_id` (logic) | HRP |
|---|---|
| `dev` | `uepdev` |
| `local` | `ueplocal` |
| `testnet` | `ueptest` |
| `main` | `uep` |

Separator: ASCII `1` (Bech32 standard).

Wallets MUST reject decode if HRP network ≠ active profile.

## 3. Binary payload (before 5-bit conversion)

Big-endian, fixed layout, **38 bytes**:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `version` | `0x01` for this spec |
| 1 | 4 | `domain_code` | u32 BE — see §4 |
| 5 | 1 | `addr_type` | §5 |
| 6 | 32 | `address_id` | BN254 Fr, 32-byte big-endian |

Total: 38 bytes → Bech32 data part (5-bit groups) + 6 character checksum.

## 4. `domain_code` registry (v1)

| Code | Name |
|---|---|
| 0 | `unspecified` (lab only) |
| 1 | `earth` |
| 2 | `mars` |
| 3 | `orbit` |
| 4–255 | reserved sequential |
| ≥ 256 | application-defined (document out-of-band) |

Full Fr `domain_id` remains the protocol ideal (ADDR-001); v1 string form uses a compact code.  
Mapping code → Fr for circuit: `Fr(domain_code)` until a later ADDR revision embeds full Fr domain in payload v2.

## 5. `addr_type`

| Value | Name |
|---|---|
| 0 | `RECEIVE` |
| 1 | `STATIC` |
| 2 | `PAYMENT_REQ` (payload is still address-shaped; full request is separate) |
| 3 | `CONTRACT` |
| 4–255 | reserved |

## 6. `address_id` bytes

Canonical Fr encoding: **32-byte big-endian** integer in `0 .. r-1` (BN254 scalar field), same as `Fr.toBytesBE()` / arkworks.

## 7. Encode algorithm

1. Build 38-byte payload.  
2. Convert bytes → 5-bit groups (Bech32 `convertbits` 8→5, pad=true).  
3. Bech32m encode with HRP from §2.  
4. Output lowercase only.

## 8. Decode algorithm

1. Lowercase; reject mixed case.  
2. Parse Bech32m; verify checksum (constant `0x2bc830a3`).  
3. HRP → `network_id`; reject unknown HRP.  
4. 5→8 bit convert; require **exactly 38 bytes**.  
5. Parse fields; reject `version ≠ 1`.  
6. Return `{ networkId, domainCode, addrType, addressId: Fr }`.

## 9. Frozen test vector (v1)

```
network_id   = testnet
domain_code  = 1 (earth)
addr_type    = 0 (RECEIVE)
address_id   = Fr(1)

ueptest1qyqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqwnptw
```

Reference: `src/lab/address-v2.ts` + `address-v2.test.ts` (9/9 PASS).

## 10. Legacy

`uep:<networkId>:<64 hex>` (`UepAddressV1`) remains **lab-only** and MUST NOT be accepted by production wallets once ADDR-002 is enabled.

## 11. Out of scope

- Payment-request QR binary (ADDR-003).  
- Directory records (DIR-001).  
- Circuit changes.
