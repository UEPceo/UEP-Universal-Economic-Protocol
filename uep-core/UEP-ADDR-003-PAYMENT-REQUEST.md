# UEP-ADDR-003 — Payment Request & QR (hardened)

**Status:** 🟢 HMAC-SHA256 under `D_PAYMENT_REQ=7`

## MAC

```
msg = "UEP-D_PAYMENT_REQ|" || canonical(fields including kid)
mac = hex(HMAC-SHA256(merchant_key, msg))[0..32]
```

- Key never appears in the QR.
- `kid` selects the merchant key on the verifier.
- Tampering amount/memo/addr → verify fails.
- Wrong key → verify fails.
- Keyless SHA-256 **removed** (unsigned only via explicit `unsigned: true`).

## URI

```
uep:pay?v=1&net=testnet&dom=1&addr=<ADDR-002>&asset=...&amt=...&exp=...&kid=...&mac=...
```

## Not yet

- Asymmetric merchant signatures (Ed25519 / circuit-friendly)
- Public key directory for `kid`
