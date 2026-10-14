# Auditoría externa 2026-10-10, Fase 4 (v0.5.45)

Node v22.22.2. 15 de 16 tests pasan. No es un apto para producción.

1. Gastos concurrentes en un proceso: el commit se perdía por un timeout de 400 ms. En tres procesos convergía.
2. Un peer podía suplantar a otro: learnPeers creía el id de la respuesta.
3. catchUp no restauraba.
4. confirm marcaba el anulador antes de aplicar.
5. El threshold del JSON no se leía, y el ADR no coincidía con el arranque.
