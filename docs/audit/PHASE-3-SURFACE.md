# Superficie para la auditoría externa — 0.5.26

Esto no es la auditoría. Es lo que hay que correr y lo que este árbol no afirma.

## Qué comprobar

```text
npm run sandbox
npm run simulate:scenario
npm run example:service
npm run audit:surface
```

`audit:surface` encadena las tres y exige `SANDBOX OK`, `SCENARIO OK` y el test del servicio de ejemplo.

## Invariantes que no cambian

- Fee de protocolo 0,1 % (`creatorFee`, suelo de 1 unidad). Fee de Marketplace 3 %.
- Snapshot de ledger en formato 10. Estado canónico UEP-25. UEP-37 no entra en el nodo.
- La API local anuncia `x-uep-api: 1.4.0`. Una versión menor puede añadir una ruta, no quitarla ni cambiar una acción firmada.
- Un gasto de nodo rechaza `development-mac` salvo el flag de laboratorio.

## Qué no se afirma

- No es una red de producción ni una red de varios nodos.
- No hay prueba de conocimiento cero de producción: no hay ceremonia.
- No hay token nativo. Las cifras de TPS de informes anteriores no son resultado de este árbol.
- Un servicio escrito fuera de este equipo, y una evaluación independiente de la API, siguen abiertos.
