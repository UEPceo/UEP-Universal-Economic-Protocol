# Disposición de la auditoría 2026-10-10 (v0.5.29)

El texto está en `AUDIT-EXTERNA-2026-10-10.md`. No se acepta un apto para varios nodos.

| Id | Disposición en 0.5.30 |
|---|---|
| H1 | El crédito exige la firma del comprador sobre el txId, y la identidad tiene que ser la dirección del emisor. |
| H2 | `POST /v1/bridge/claim` reclama un gasto ya confirmado. |
| H3 | La retirada incluye semilla, nonce y altura de caducidad. El nonce no se reutiliza. |
| H4 | El barrido comprueba antes de gastar y descuenta la salida de la deuda. |
| H5 | El tope sale del núcleo. La ruta HTTP corta en 1.024. |
| H6 | Seq monótono, ventana de 1.024, `after` y `limit`. |
| H7 | La clave del árbitro queda en el nodo. `GET /v1/categories` las publica. Las acciones firmadas no tienen ruta propia. |
| H8 | El valor tiene que ser un entero no negativo. Sigue sin liquidar. |
| H9 | Con dominio distinto de 0 el blinding es un hash. No se recupera restando. |
| H10 | `categoryContracts` y los enunciados entran en el snapshot. |
| H11 | `UEP_DATA_DIR` guarda claves, dominio y snapshots. El arranque reabre ledger y Marketplace. |
