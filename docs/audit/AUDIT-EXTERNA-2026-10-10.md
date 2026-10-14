Auditoría UEP v0.5.29: puente HTTP, categorías y oráculo
Fecha: 10 de octubre de 2026. Comparado con la 0.5.26 que ya había revisado. Node 22, un núcleo.
1. Lo que ejecuté
• npm run sandbox: SANDBOX OK.
• npm run simulate:scenario: SCENARIO OK (con aviso de deprecación por la opción en ms de la telemetría IoT).
• npm run audit:surface: falla (código 1): AUDIT_SURFACE_FAIL run test:marketplace. Es correcto que falle: desde la 0.5.27 incluye test:marketplace, que tiene 3 fallos.
• test:marketplace 224/227, test:protocol 214/214, test:settlement 20/20, test:oracle 38/38, test:category 24/24.
• Cinco pruebas de concepto sobre assembleNode y la API de servicio.
No revisé Rust, labs, rendimiento ni CI.
2. Qué está arreglado desde la 0.5.26
• La retirada debita monto más fee y exige la firma del comprador (el test del puente da 3.999 tras retirar 1.000 de 5.000).
• recover busca la transacción en el ledger y rechaza ids inventados.
• El alta de identidades exige una firma de posesión; hay GET /v1/events.
• El disco recarga el índice y borra los bytes.
• Las categorías aceptan minúsculas.
• audit:surface ya no oculta la suite roja.
3. Lo que afirma esta versión, punto por punto
Afirmación
Resultado
GET /v1/bridge/info publica la custodia
Cierto (dirección y activo fijo uep-test/teur)
Depósito: el cliente aporta la nota, se acredita solo lo recibido
Cierto en el importe; falso en la atribución (H1, H2)
Retirada: debita monto más fee
Cierto, pero la firma es repetible (H3)
Swap, relay, dispute y drip instanciados
Cierto, pero inalcanzables y el árbitro no puede firmar (H7)
POST /v1/oracle/quotes firmado por el administrador; lectura settles: false
Cierto; sin validación de valor y sin efecto en el Marketplace (H8)
4. Hallazgos confirmados con prueba
H1 · Alto · Quien envía primero un depósito se queda el crédito
POST /v1/bridge/deposit recibe buyerId en el cuerpo, fuera de la transacción firmada. Reproducido: Alice firma un gasto de 5.000 hacia la custodia; Mallory envía esa misma transacción con buyerId: "mallory". Resultado: saldo de Mallory 5.000, saldo de Alice 0, y cuando Alice la envía después recibe REPLAY.
Arreglo: ligar el comprador a la operación: exigir una firma del comprador sobre (txId, buyerId), o incluir el id del comprador en un campo firmado de la transacción.
H2 · Alto · Depósitos huérfanos por la ruta genérica
Si el gasto a la custodia entra primero por el ledger (/v1/ledger/transactions), la ruta del puente responde REPLAY y no acredita. Reproducido: custodia con 8.000, crédito de Alice 0. Nada en la API recupera esos fondos; recover no está expuesto.
Arreglo: que el puente reconozca notas entrantes a la custodia (escanear transacciones confirmadas) y ofrezca una reclamación firmada por el emisor del gasto (resuelve también H1).
H3 · Alto · La firma de retirada se puede repetir
El mensaje firmado es uep-bridge-withdraw:mercado:comprador:destino:activo:monto. No incluye openingSeed, ni nonce, ni caducidad. Reproducido: la misma firma se aceptó 4 de 4 veces con semillas distintas y el destino recibió 4.000. Quien capture una firma puede sacar el saldo del comprador a su dirección, en trozos, quemando una fee del 0,1 % cada vez.
Arreglo: firmar también openingSeed y un nonce con caducidad en altura; guardar los nonces usados en el snapshot.
H4 · Alto · Tras un barrido de gas el puente queda inutilizado
sweepGas gasta monto + fee de la custodia, pero la deuda (liability, un mapa en memoria) no baja. Reproducido: custodia 994 frente a deuda 1.000; reconcile lanza BRIDGE_INSOLVENT y toda operación posterior falla. Peor: el siguiente depósito aplica el gasto en el ledger y el crédito en el Marketplace antes de que reconcile lance el error, así que la API devuelve error con el estado ya cambiado. Además la deuda no sobrevive a un reinicio y la fee se calcula con el suelo por defecto, no con el del registro del activo.
Arreglo: derivar la deuda del Marketplace (credited menos gas barrido) en vez de un mapa; descontar monto + fee al barrer, o cobrar la fee del importe barrido; comprobar reconcile antes de mutar y hacer cada movimiento atómico; usar protocolFeeFloor del activo.
H5 · Medio · El tope de 256 identidades rompe el sistema y es trivial de llenar
El tope está fijo en el núcleo (marketplace.ts:863), no en la ruta HTTP. Consecuencias: scale-20k.test.ts falla con IDENTITY_CAP; la simulación de 20k usuarios se cae incluso con 300; y como la firma de posesión la hace la propia clave del solicitante, 255 altas con claves generadas llenan el Marketplace. Reproducido: tras 255 altas basura, un usuario legítimo recibe IDENTITY_CAP.
Arreglo: tope configurable en la capa HTTP, no en el núcleo; alta con coste (fee o depósito) o aprobada por el administrador; derivar el id de la clave; rate limit por origen.
H6 · Medio · seq del bus de eventos deja de ser único
Tras cortar a 1.024 eventos, seq = events.length + 1 vale 1.025 para todos los nuevos. Reproducido con 1.100 eventos: 949 seq distintos entre 1.024 conservados. El conjunto de ids vistos sigue creciendo sin límite y GET /v1/events devuelve todo, sin after.
Arreglo: contador monotónico propio, GET /v1/events?after=seq&limit=, y retener ids solo para la ventana.
5. Hallazgos por inspección y de prueba
H7 · Medio · Categorías instanciadas pero inutilizables
Swap, relay, dispute y drip se construyen en assembleNode y se devuelven como node.categories, pero ni la API de servicio, ni HTTP, ni el SDK las exponen. La identidad uep-node-arbiter se crea y su clave privada se descarta: nadie puede firmar un veredicto, así que una disputa no se puede resolver. El test solo comprueba typeof … === "function".
H8 · Medio · Oráculo
• POST /v1/oracle/quotes acepta -5 sin error (no hay validación de rango) y la secuencia es siempre 1n.
• BigInt("no-es-numero") lanza SyntaxError, que el manejador convierte en 400 «body is not valid JSON» (mensaje engañoso, consecuencia del mapeo de SyntaxError).
• set() guarda el valor en posted antes de validar y quote() recurre a posted si el agregador no lo acepta: los controles del agregador se pueden saltar.
• El Marketplace del nodo no recibe puerta de oráculo, así que las cotizaciones no afectan a ningún pedido. Es coherente con settles: false, pero entonces el oráculo del nodo es informativo.
H9 · Medio · Blinding: el «dominio» no arregla el problema
walletOutputBlinding = (contador+1)*16 + tag + dominio. El dominio es una constante aleatoria por instancia, suma fija, y el blinding viaja en claro en la transacción; cualquier observador recupera el dominio restando. No está mezclado con el secreto del wallet, no se guarda en el snapshot, y el valor por defecto de la biblioteca sigue siendo 0. Derivar el blinding del secreto (H(secreto, contador, tag)).
H10 · Medio · El Marketplace no persiste categoryContracts
El test every Map / Set field … falla porque categoryContracts no está persistido ni declarado solo de ejecución: tras restaurar un snapshot se pierden las categorías registradas después del arranque.
H11 · Bajo-medio · Persistencia parcial del nodo
UEP_DATA_DIR guarda custody.mnemonic y fee.mnemonic en texto plano (sin modo 0600), pero no el ledger ni el Marketplace. Tras reiniciar, la misma dirección de custodia apunta a un ledger vacío. Las claves de administrador y árbitro se regeneran.
H12 · Proceso
Tres tests de marketplace fallan: evidence-statement.test.ts (error de test: lee .includes de undefined), el de mapas persistidos (H10) y scale-20k (H5). audit:surface, que es la «superficie para la auditoría externa», termina en rojo.
6. Siguiente paso recomendado
Antes de pedir la auditoría externa:
1. H1 + H2 + H3 juntos: rediseñar depósito y retirada con firma del comprador sobre una operación completa (id, monto, destino, semilla, nonce, caducidad) y reclamación de notas entrantes.
2. H4: liability derivada y movimientos atómicos.
3. H5: mover el tope fuera del núcleo.
4. Dejar npm test y audit:surface en verde.
Después: exponer las categorías por API con un árbitro real (H7), persistencia completa del nodo (H10, H11), seq y paginación de eventos (H6), blinding derivado del secreto (H9) y validación del oráculo (H8).
Puedo prepararlo como parche con tests de regresión: las pruebas de concepto de H1, H2, H3, H4, H5 y H6 ya existen como scripts cortos.