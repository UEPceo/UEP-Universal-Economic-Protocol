# Disposición — auditoría Fase 4 (v0.5.45)

| Id | Disposición en 0.5.46 |
|---|---|
| 1 | El timeout de pares pasa a 5 s. El gasto concurrente en un proceso converge. |
| 2 | learnPeers solo acepta el id de la lista. Un id distinto se ignora. |
| 3 | catchUp pide el snapshot y restaura. El arranque lo llama. |
| 4 | El anulador se marca después de un submit correcto. Si falla, se puede reintentar. |
| 5 | El threshold se lee de config/peers.json. El ADR dice que las claves se aprenden de /status. |

No se acepta un apto para producción.
