# Hallazgos añadidos sobre la última versión

Texto recibido el 2026-10-10. No es un dictamen de este árbol hasta contrastarlo con el código.

## VULN-UEP-08

`releaseCollateral` no comprueba la paridad entre el colateral y `totalSyntheticCirculating`. Pide un `ZkBurnReceipt` antes de liberar colateral.

## VULN-UEP-09

`blindingFactor` cae a `Date.now()` y queda en unos 28 bits.

## PROP-SEC-01 a 05

Circuit breaker al 5 % del colateral, HKDF, pinning de verifying key con quórum de validadores, proof-of-work en el paymaster, y Kyber-768 en sockets entre validadores.
