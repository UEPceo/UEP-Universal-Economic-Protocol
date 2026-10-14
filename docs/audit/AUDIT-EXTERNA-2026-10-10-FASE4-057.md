# Auditoría externa 2026-10-10, Fase 4 (v0.5.57)

No apto para producción. 26 de red y 8 de rotación, quórum y liquidación pasan.

Hallazgo reproducido: un `/status` sin autenticar podía sustituir la clave de un votante. `learnPeers` creía el id declarado y `setVoter` reemplazaba la clave.
