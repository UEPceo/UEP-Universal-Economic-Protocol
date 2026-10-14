# Auditoría externa 2026-10-10, Fase 4 (v0.5.58)

Node v22.20.0. test:net 27/27. Quórum, rotación y liquidación 8/8. No apto para producción.

H1. `/vote` votaba sin persistir.
H2. `exportState` no guardaba `confirmed`.
H3. El ADR se contradecía sobre el aprendizaje de claves. `peers.json` no trae pines.
H4. El ADR decía timeout de 5 s; el código usa 15 s.
