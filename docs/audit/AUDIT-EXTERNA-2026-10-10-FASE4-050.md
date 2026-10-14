# Auditoría externa 2026-10-10, Fase 4 (v0.5.50)

No apto para producción. Dos hallazgos reproducidos:

1. catchUp podía sustituir un estado nuevo por un snapshot anterior.
2. El estado del quórum vive en memoria. Un reinicio olvidaba los votos y podía firmar un gasto incompatible del mismo anulador.
