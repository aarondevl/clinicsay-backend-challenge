# Recordatorios de citas · ClinicSay

Servicio que crea, reprograma y cancela citas de clínicas, envía a cada
paciente un recordatorio el día anterior a través de un proveedor de mensajes
y aplica las respuestas SI/NO que llegan por un webhook.

- Enunciado: [`enunciado.pdf`](enunciado.pdf). Contrato de la API:
  [`openapi.yaml`](openapi.yaml). Proveedor simulado: [`provider/`](provider/).
- Decisiones con su porqué y estado del trabajo:
  [`docs/2026-11-23-recordatorios-design.md`](docs/2026-11-23-recordatorios-design.md).
- Guía para agentes y personas que cambien el código (mapa regla → archivo →
  test, invariantes, comandos): [`AGENTS.md`](AGENTS.md).

Stack: Node 24, TypeScript estricto, NestJS 12 (ESM), MikroORM 7, Postgres 17,
Luxon, Vitest y supertest, oxlint y Prettier, GitHub Actions.

## 1. Cómo levantarlo y pasar los tests

Levantar todo (api en el puerto 3000 con `CLOCK_MODE=test`, Postgres y el
proveedor en el 4010). Las migraciones corren al arrancar y `GET /health`
responde 200 cuando la base está conectada y migrada:

```bash
docker compose up --build
```

Tests (Node 24, ver `.nvmrc`, y Docker):

```bash
npm ci
npm run db:up        # solo el Postgres del compose, en 127.0.0.1:55432
npm run verify       # lint (oxlint + Prettier), tipos, unitarios y e2e
```

- Los unitarios cubren el dominio sin Nest ni base. Los e2e levantan la app
  real con `createApp` contra Postgres (base `clinicsay_test`, que crean si no
  existe) y contra el proveedor real de `provider/server.mjs`, que lanzan en el
  puerto 4011: no interfieren con un compose levantado.
- `npm run verify` es la definición de terminado: 19 archivos y 212 unitarios,
  8 archivos y 185 e2e.

Prueba de humo contra el compose (necesita bash, curl, grep y sed; sin jq):

```bash
docker compose up --build -d --wait
scripts/smoke.sh     # reloj → clínica → paciente → cita → pasada → mensaje exacto
docker compose down -v
```

`scripts/smoke.sh` usa el ejemplo del enunciado (cita el 28/03/2027 a las
10:00 de Madrid, recordatorio a las 09:00 UTC del día anterior), comprueba
`{"processed":1}`, el texto exacto y la `Idempotency-Key` en el proveedor, y
sale con 1 y un mensaje si algo no cuadra. Se puede repetir sobre la misma
base. `API_URL` y `PROVIDER_URL` cambian los destinos.

CI (`.github/workflows/ci.yml`), obligatorio para entrar en `main`:

- `checks`: lint, tipos, unitarios, e2e (con un Postgres de servicio) y build.
- `compose`: `docker compose up --build --wait`, `GET /health` y
  `scripts/smoke.sh`; si falla, vuelca los logs.

Para Claude Code hay una skill del proyecto,
[`.claude/skills/verificar`](.claude/skills/verificar/SKILL.md), que corre todo
lo anterior y explica qué hacer si algo falla.

## 2. Decisiones

### Arquitectura

Capas con las dependencias hacia dentro, `http` → `application` → `domain`, e
`infrastructure` implementando los puertos de `application`:

| Carpeta | Qué hay |
|---|---|
| `src/domain` | Reglas como funciones puras: hora de envío y franja, texto, transiciones de cita y recordatorio, reintentos, lectura de SI/NO. Sin Nest, sin MikroORM, sin E/S y sin leer la hora. |
| `src/application` | Un caso de uso por archivo (clases sin decoradores) y los puertos como clases abstractas: `Clock`, `IdGenerator`, `Transactions`, repositorios, `MessageProvider`, `Logger`. |
| `src/infrastructure` | MikroORM (entidades, repositorios, migraciones en SQL escrito a mano), cliente HTTP del proveedor, relojes, ids UUIDv7, `/health`. |
| `src/http` | Controladores finos, DTOs con class-validator, presentadores y el filtro que traduce los errores propios a `{ "error": "..." }` con 400, 404, 409 o 503. |

- Los casos de uso reciben sus puertos por constructor y se cablean en
  `app.module.ts` con `useFactory`; se prueban sin Nest.
- Cada caso de uso que escribe abre su transacción con `Transactions.run`.
  Los repositorios devuelven tipos del dominio, nunca entidades.
- `test/architecture.spec.ts` falla si `domain` o `application` importan lo
  que no deben.
- La hora de negocio sale siempre del puerto `Clock`, nunca de `Date.now()`
  ni de `now()` de Postgres. Con `CLOCK_MODE=test`, `PUT /test/clock` la deja
  congelada hasta el siguiente `PUT`.

### Cómo se evitan los envíos duplicados

- **Postgres hace de cola.** La pasada toma el siguiente recordatorio con
  `FOR UPDATE SKIP LOCKED`, por `next_attempt_at` e id (índice parcial
  `reminder_due`). Varias pasadas a la vez, o varias réplicas, nunca toman el
  mismo.
- **Una transacción por recordatorio.** Dentro se vuelven a comprobar las
  reglas con la hora del servicio (`too_late`, `no_phone`, `opted_out`, en ese
  orden), se llama al proveedor y se guarda el resultado antes del `COMMIT`.
  La llamada va dentro de la transacción a propósito: mientras dura, la fila
  sigue bloqueada y ninguna otra pasada puede repetir ese intento.
- **`Idempotency-Key` = id del recordatorio en todos los intentos.** Tras un
  504, un error de red o 5 s sin respuesta («puede haberse entregado») el
  reintento lleva la misma clave; si ya se entregó, el proveedor responde 200
  `duplicate` y el recordatorio queda `sent` sin que el paciente reciba dos
  mensajes.
- **Un solo pendiente por cita:** índice único parcial `reminder_one_pending`.
- **Orden de bloqueo.** Reprogramar, cancelar y el webhook bloquean primero la
  cita y después sus pendientes, así que dos peticiones sobre la misma cita se
  ponen en fila y quien espera al job ve el estado final del recordatorio. El
  job, que ya tiene el recordatorio, lee la cita sin bloquearla: esperarla
  cerraría un ciclo con un `PATCH` y Postgres abortaría uno con `40P01`.
- **Respuestas sin duplicar:** el `messageId` se registra con
  `insert ... on conflict do nothing` en la misma transacción que su efecto.
- **Un recordatorio con un error inesperado no frena la cola:** se deshace su
  transacción, se registra con su id y la pasada sigue con los demás. Queda
  `pending` y no `failed`, porque el error pudo llegar después de que el
  proveedor lo aceptara; la pasada siguiente lo repite con la misma clave.
- **Cierre ordenado:** con SIGTERM no se toma ningún recordatorio más y se
  espera a que el que está en curso se guarde (`ShutdownCoordinator`, en
  `beforeApplicationShutdown`).

Respuestas del proveedor: cualquier 2xx es `sent`; cualquier 4xx es `failed`
sin reintento; 5xx, error de red, timeout, 1xx y 3xx se reintentan a 1 y a
5 minutos (`RETRY_DELAYS_MINUTES` en `src/domain/retry-policy.ts`, la única
definición) y al tercer fallo queda `failed`. Los reintentos no esperan a que
acabe la franja de silencio.

### Zonas horarias

- Todo se guarda en `timestamptz`. Las respuestas salen en UTC con `Z` y sin
  milisegundos cuando son cero (`2027-03-27T09:00:00Z`, como el contrato).
- Las fechas de entrada necesitan zona (`Z` u offset) y la forma `date-time`
  del contrato; si no, 400. También es 400 una fecha que en UTC cae fuera de
  los años 1 a 9999, que Postgres no guarda.
- La hora local se calcula con Luxon y la zona IANA de la clínica. La hora de
  envío es la misma hora local del **día de calendario** anterior (`minus({
  days: 1 })` en hora local, no 24 h): para la cita del 28/03/2027 a las 10:00
  de Madrid sale el 27/03 a las 10:00 de Madrid, 09:00 UTC, con 23 h entre
  medias. Canarias (`Atlantic/Canary`) funciona igual con su zona, y el texto
  lleva la fecha y la hora locales de la clínica.
- Franja de silencio `[21:00, 09:00)` en hora local: las 21:00 en punto se
  mueven y las 09:00 en punto se envían. Lo que cae dentro pasa a las 09:00
  siguientes. Las horas que no existen o se repiten el día del cambio (de
  02:00 a 03:00 en la península y de 01:00 a 02:00 en Canarias) caen dentro de
  la franja y acaban también a las 09:00.
- Solo se aceptan zonas IANA: `local`, `system` y los offsets fijos (`+01:00`)
  dan 400, porque dependen de la máquina o no tienen cambio de horario.
- Los tests usan los bordes del enunciado: los dos cambios de horario,
  Canarias, las 21:00 y las 09:00.

### Qué se descartó

- **Redis o una cola (BullMQ, SQS):** Postgres con `SKIP LOCKED` basta para
  este volumen y deja el intento y su resultado en la misma transacción. La
  evolución está en la nota de producción.
- **`@nestjs/idempotency`, `@nestjs/resilience` y Nest Observe**, que sugiere
  la plantilla de Nest: la idempotencia y los reintentos son reglas del
  enunciado y viven en el dominio y en Postgres, donde se prueban con el reloj
  de test.
- **Jest:** Vitest es el runner de la plantilla de Nest 12 en ESM y tiene la
  misma API. Tampoco ESLint: la plantilla trae oxlint, con reglas que usan los
  tipos (`no-floating-promises` como error).
- **Mockear el proveedor:** los e2e usan el de `provider/server.mjs` y
  provocan los fallos con su API de administración.
- **RLS por clínica, autenticación, paginación:** fuera del alcance del
  enunciado.

### Ambigüedades resueltas

- **Citas virtuales** (se mencionaron en la reunión informativa, no están en
  el contrato): campo opcional `virtual` en `POST /appointments`, por defecto
  `false`. Con `true`, la hora de envío, la franja y el texto usan
  `Europe/Madrid`. La respuesta solo incluye `virtual` cuando vale `true`, así
  que una cita creada sin el campo tiene exactamente la forma del contrato.
- **Reintentos:** 1 y 5 minutos, 3 intentos, como dice el enunciado (en la
  reunión se habló de cada minuto). Se cambian en una constante.
- **Franja:** siempre las 09:00 siguientes en hora local.
- **Rechazo del proveedor:** 422 y cualquier otro 4xx dejan `failed`; cualquier
  2xx es `sent`.
- **Reloj de pruebas:** usa la hora del sistema hasta el primer `PUT` y desde
  ahí queda congelado.
- **Orden de los recordatorios con el reloj congelado:** ids UUIDv7 generados
  por la aplicación y la lista ordenada por id, porque las fechas empatan.
- **«Último recordatorio enviado» a un teléfono:** número de envío de la
  secuencia `reminder_send_seq`, asignado al quedar `sent`; `sentAt` empata con
  el reloj congelado. «No ha empezado» se mira con el reloj del servicio y
  `receivedAt` solo se guarda.
- **Respuestas:** solo una palabra, SI o NO, con mayúsculas, tildes, espacios
  y signos alrededor; «Sí, gracias» se ignora. SI sobre una cita ya confirmada
  no cambia nada, y SI después de reprogramar confirma la hora nueva.
- **Cancelar o reprogramar durante un envío:** esperan al bloqueo del
  recordatorio (5 s como mucho) y ven su estado final.
- **Cancelar una cita que ya empezó:** 200 y queda cancelada (el contrato de
  `/cancel` solo prevé 200 y 404). Una ya cancelada se devuelve sin escribir.
- **Ids que no son UUID** (en la ruta o en el cuerpo): 404, como uno que no
  existe.
- **Orden de los errores:** 400 de esquema, 404, 409 y al final 400 de negocio
  (paciente de otra clínica, `startsAt` no futura).
- **Textos de entrada:** sin el carácter NUL y con una longitud máxima (200
  para nombres y `from`, 255 para `messageId`), porque Postgres los rechazaba
  con un 500. En el webhook también es 400: un `messageId` que no se puede
  guardar no se puede deduplicar.
- **`from` del webhook:** no se valida como E.164; un teléfono sin envíos no
  encuentra cita y responde 200.

## 3. Qué quedó fuera y qué se haría con más tiempo

Comportamientos conocidos que se cambiarían:

- Un id con un `%` mal codificado en la ruta da 400 (lo responde Express antes
  del controlador) en vez de 404.
- `parseReply` trata las cifras como signos (`2 si` cuenta como SI) y quita
  cualquier diacrítico, no solo las tildes (`ño` cuenta como NO).
- 408 y 429 del proveedor quedan `failed` por la regla «cualquier 4xx»; con un
  proveedor real se reintentarían (respetando `Retry-After`).
- Un recordatorio que falla siempre con un error inesperado se reintenta en
  cada pasada sin límite: queda `pending` y se registra en el log. Si el error
  llega después de la llamada, el proveedor recibe una petición por pasada;
  con la misma clave el paciente no recibe dos mensajes, pero con un proveedor
  sin idempotencia sí (ver la nota de producción). Haría falta contar los
  errores y apartarlo para revisión. Un caso: con el reloj de test a las
  `9999-12-31T23:59:30Z`, un 503 programa el reintento en el año 10000,
  Postgres no lo guarda (`22009`) y la pasada responde `{"processed":0}` con
  el recordatorio `pending` y `attempts` 0. Con el reloj del sistema no se da.
- La lista de recordatorios ya tratados de una pasada crece con cada uno
  (`NOT IN` con todos los ids); fijar la hora al empezar la pasada lo evitaría.
- `GET /appointments/{id}` lee la cita y sus recordatorios en dos sentencias
  con READ COMMITTED: un `PATCH` concurrente podría mostrar una vez un estado
  mezclado.
- Un NUL en el `messageId` del webhook da 400, y el proveedor reenviaría el
  mensaje; se podría responder 200 y descartarlo, o guardar un hash del id.
- `loadConfig` no valida las variables: un `PROVIDER_TIMEOUT_MS` que no es un
  número da `NaN`, un `CLOCK_MODE` mal escrito pasa al reloj del sistema sin
  avisar y un `PROVIDER_URL` con barra final llama a `//messages`.
- Un `PATCH` con el mismo `startsAt` desconfirma la cita y crea otro
  recordatorio (lectura literal de la regla 8).
- Un offset con el signo menos de Unicode (`−05:00`) pasa como zona válida;
  `z` minúscula y los offsets sin dos puntos (`+0200`) dan 400.
- `POST /appointments` no es idempotente (el contrato no tiene clave).
- Con la base caída, `POST /appointments` con un `clinicId` que no es UUID da
  503 en vez de 404 (comprueba el id dentro de la transacción).
- Respuestas: dos NO seguidos desde un teléfono compartido cancelan dos citas;
  un NO durante un `lost-response` va a la cita anterior; `from` se compara tal
  cual, sin normalizar; un mensaje ignorado no deja traza; e
  `inbound_message` crece sin purga.
- `/health` no comprueba que las migraciones sigan aplicadas si la base se
  recrea en caliente, y el pool no tiene `connectionTimeoutMillis`.

Tests y código:

- Algunos invariantes de `AGENTS.md` no tienen un test propio y dependen de la
  revisión (por ejemplo, que nada fuera de los relojes lea la hora del
  sistema); se cubrirían con reglas de lint o tests de arquitectura.
- Los e2e de concurrencia esperan 200 ms a que la otra transacción llegue al
  bloqueo: en un CI lento podrían pasar sin probarlo (nunca dan un falso
  rojo). Se cambiarían por una espera sobre `pg_locks`.
- No hay un e2e del job con la base cortada de verdad: su 503 se prueba con
  una transacción que lanza el error al confirmar.
- El bloque «cancelar la cita y sus pendientes» se repite en el webhook y en
  `CancelAppointment`.

Producto:

- Configuración por clínica (franja de silencio, horario de atención): hoy la
  franja es una constante del dominio, y `outOfQuietHours` supone una franja
  que cruza la medianoche.
- La firma del webhook (ver la nota de producción), RLS por clínica y
  autenticación.

## 4. Nota de producción

**Carga y planificación.** 20 000 recordatorios al día son unos 28 por minuto
en las 12 h en que se envía, pero la franja manda a las 09:00 en punto todo lo
que caería entre las 21:00 y las 09:00 (una hora después en Canarias): citas
de primera hora y las creadas o reprogramadas de noche. Pueden ser cientos o
miles en el mismo minuto. Un cron cada minuto (CronJob de Kubernetes o
EventBridge Scheduler) lanza varias llamadas a `POST /jobs/reminders/run`
repartidas entre réplicas, y `SKIP LOCKED` reparte los recordatorios sin
coordinación. Cada pasada es secuencial y ocupa una conexión durante cada
llamada (hasta 5 s): el pool se dimensiona para las pasadas en paralelo y cada
pasada se limita en tiempo para no pasar del timeout de la petición.

**Evolución del envío.** Con más volumen, la llamada sale de la transacción
para no retener conexiones:

- *Reserva con `locked_until`:* una transacción corta reserva el recordatorio
  (por ejemplo, 30 s), se llama al proveedor fuera y otra transacción guarda
  el resultado. Si la réplica muere, otra lo toma al vencer la reserva, con la
  misma `Idempotency-Key`.
- *Outbox con cola (SQS o Redis):* un relé publica cada envío cuando le toca y
  los consumidores vuelven a comprobar el estado (cancelada, reprogramada)
  antes de llamar al proveedor. «Al menos una vez» es seguro con la clave, y
  una cola de mensajes muertos aparta lo que falla siempre.

**WhatsApp real.** Fuera de la ventana de 24 h desde el último mensaje del
paciente solo se envían plantillas aprobadas: el texto pasa a ser una
plantilla con variables y botones SI/NO, y `parseReply` queda para quien
escribe la respuesta. Hay límites de ritmo (mensajes por segundo) y de
destinatarios al día según el nivel de la cuenta, que el job respeta con un
limitador. Si la API no admite una clave de idempotencia, el id del
recordatorio viaja como dato de seguimiento del mensaje y vuelve en los avisos
de estado (entregado, leído, fallido); tras un timeout se espera ese aviso
antes de reintentar, o se acepta el riesgo de un duplicado. Las bajas se
sincronizan con las del canal.

**Webhook.** Se verifica la firma HMAC del cuerpo crudo (en Meta,
`X-Hub-Signature-256`) antes de procesar nada, y el `messageId` sigue
deduplicando. `inbound_message` se purga pasado un tiempo.

**Despliegue.** Contenedores con despliegue gradual: `/health` como readiness,
SIGTERM con cierre ordenado (ya implementado) y un periodo de gracia mayor que
el timeout del proveedor. Migraciones compatibles hacia atrás (añadir, migrar
datos, quitar en otra versión), en un paso propio antes del despliegue y no al
arrancar cada réplica. Postgres gestionado con copias y recuperación a un
instante. `CLOCK_MODE=test` nunca en producción.

**Monitorización.** La alerta principal es el retraso entre `scheduledFor` y
`sentAt` (p95) junto con la antigüedad del pendiente más viejo que ya toca.
Además: tasas de `failed` y de `skipped` por motivo, reintentos, latencia y
errores del proveedor por código, recordatorios que fallan en cada pasada (el
log lleva su id), duración de las pasadas y respuestas aplicadas, ignoradas y
repetidas. Logs estructurados con ids, sin teléfonos ni textos (son datos de
salud). `scripts/smoke.sh` corre tras cada despliegue en un entorno con reloj
de test y el proveedor falso; en producción haría falta otra variante.

## 5. Uso de la IA

Se trabajó con Claude Code en todo el proyecto:

1. **Plan con decisiones.** A partir del enunciado, el contrato, el proveedor
   y la reunión informativa se escribió el documento de diseño: el pedido con
   las ambigüedades y cómo se resuelven, las decisiones con su porqué y un plan
   en tareas con sus tests y un «Review Focus» con los casos que más fácil se
   escapan. `AGENTS.md` y `CLAUDE.md` se escribieron antes del código y los
   revisó un segundo modelo.
2. **Una sesión coordinadora y una trabajadora por tarea.** La coordinadora
   reparte cada tarea a una sesión trabajadora con su propio worktree y su
   rama, que entra por PR a `main` con el CI en verde (`checks`, y desde #5
   también `compose`) y merge commit (#1 a #12 y la de esta entrega).
3. **Tests vistos en rojo.** Desde #3, cada test nuevo se vio fallar por su
   motivo: con la función ausente y, cuando pasaba desde el principio, con una
   mutación temporal del código. Las PR de código desde #5 cuentan las
   mutaciones que se usaron.
4. **Revisión.** Cada PR se revisó contra el plan, `AGENTS.md` y el Review
   Focus, y al final otro modelo revisó todo `main`; de esa revisión salieron
   #11 y #12.

Lo que se corrigió de lo que propuso la IA (cada punto consta en su PR o en
el estado del documento de diseño):

- El plan daba por hecho ESLint; la plantilla de Nest 12 en ESM trae oxlint.
  La plantilla también genera su propio `AGENTS.md`/`CLAUDE.md`, que habría
  pisado los del repositorio.
- El plan ponía `newId()` en el dominio: un UUIDv7 lee la hora del sistema, así
  que los ids salen del puerto `IdGenerator` (#6).
- Postgres publicado en el 5432 chocaba con uno local (pasó al 55432), y el
  healthcheck por socket daba por lista la base durante su primera
  inicialización (#5).
- El validador de fechas aceptaba cualquier ISO 8601 de Luxon: `10:00:00Z`
  completaba la fecha con la de la máquina y no con la del reloj, y un año de 5
  cifras daba 500 (#7).
- El identity map de MikroORM devolvía la fila vieja tras un `update` en la
  misma transacción; los repositorios de citas y recordatorios leen sin él
  (#8).
- Faltaban tests que fallaran al quitar un bloqueo que el plan sí pedía: con
  esa mutación, cancelar con un `PATCH` esperando perdía la hora nueva (#8) y
  el job, al esperar a la cita, hacía que Postgres abortara una transacción con
  `40P01` (#9). La regla de bloqueo de `AGENTS.md` no decía que el job nunca
  puede esperar a la cita (#8).
- El cierre del job en `onApplicationShutdown` llegaba tarde: Nest cierra antes
  el servidor HTTP, que espera a la petición del job, y la pasada vaciaba la
  cola. Además, un 201 o 204 del proveedor dejaba `failed` un mensaje
  entregado (#9).
- La expresión del plan para leer SI/NO era cuadrática: 100 000 caracteres
  tardaban 10 s con el proceso bloqueado (#10).
- Entradas con el carácter NUL, un `messageId` largo o años fuera de 1-9999
  daban 500; con el reloj en el año 0, el job y el webhook quedaban en 500 en
  cada llamada (#11).
- Un recordatorio con un error inesperado cortaba la pasada y, como iba
  primero, bloqueaba la cola en todas las siguientes. Un test de error de red
  apuntaba a un puerto recién liberado que otro proceso llegó a ocupar (#12).

## Reglas de código

El detalle está en [`AGENTS.md`](AGENTS.md#reglas-de-código); en resumen:

- SOLID con inyección de dependencias: los casos de uso dependen de puertos
  (clases abstractas) y las implementaciones se cablean en `app.module.ts`.
- Errores propios (`ValidationError`, `NotFoundError`, `ConflictError`) en
  los casos de uso, y `ServiceUnavailableError` cuando la base no responde
  (en `/health` y en `Transactions.run`); solo la capa HTTP los traduce a 400,
  404, 409 y 503 con
  `{ "error": "<mensaje>" }`. El dominio devuelve resultados y no lanza
  errores de la API. `try/catch` en los límites con E/S.
- TypeScript estricto sin `any`.
- JSDoc en los métodos públicos.
- Tests con Vitest.
