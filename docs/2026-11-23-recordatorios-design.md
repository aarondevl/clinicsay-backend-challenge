# Recordatorios de citas por SMS

Fuente de verdad: `enunciado.pdf` y `openapi.yaml`. Este documento resume lo que
pide el enunciado y guarda las decisiones; ante cualquier duda manda el PDF.

## 1. Pedido (2026-11-23)

Servicio que crea, reprograma y cancela citas de clínicas y envía un recordatorio
por mensaje a cada paciente el día anterior a través de un proveedor externo
(simulado en `provider/`). El paciente responde SI o NO y la cita se confirma o
se cancela.

### Restricciones fijas

- Node 22 o superior, TypeScript y PostgreSQL. Framework, librerías y estructura
  son libres.
- `docker compose up --build` levanta `api` en el puerto 3000 con
  `CLOCK_MODE=test` y `PROVIDER_URL=http://provider:4010`, su base de datos y el
  `provider`. El servicio `provider` no se modifica.
- Migraciones al arrancar. `GET /health` responde 200 cuando la base está
  conectada y migrada.
- No hace falta autenticación, front, editar clínicas o pacientes, paginación ni
  un proveedor real. Tampoco datos de ejemplo: la evaluación usa tests ocultos
  contra el contrato (rutas, campos, estados y códigos).
- Está pensada para 3-4 h. Lo que no se haga se cuenta en el README con el porqué.

### Reloj

- Con `CLOCK_MODE=test`, `PUT /test/clock { now }` (responde 204) fija la hora
  que el servicio usa para todo: crear y reprogramar citas, las pasadas del job y
  los webhooks. Sin ese modo el endpoint no existe (404).
- Consecuencia: ninguna regla de negocio puede usar `now()` de Postgres ni
  `Date.now()` directamente; la hora llega siempre desde el reloj del servicio.

### Contrato (`openapi.yaml`)

- Fechas de entrada en ISO 8601 con zona (`Z` u offset); en las respuestas,
  siempre UTC con `Z`. Errores: `{ "error": "<mensaje>" }`.
- `POST /clinics` → 201. 400 si faltan datos o la zona IANA no existe.
- `POST /patients` → 201. 400 si el teléfono no es E.164 (`phone` puede ser
  `null`); 404 si la clínica no existe.
- `POST /appointments` → 201 con su recordatorio. 400 si los datos son
  inválidos, `startsAt` no es futura o el paciente no es de esa clínica; 404 si
  la clínica o el paciente no existen.
- `GET /appointments/{id}` → 200 con **todos** sus recordatorios, del más
  antiguo al más nuevo; 404 si no existe.
- `PATCH /appointments/{id} { startsAt }` → 200. 400 si los datos son inválidos o
  `startsAt` no es futura; 404 si no existe; 409 si la cita está cancelada o ya
  empezó.
- `POST /appointments/{id}/cancel` → 200; si ya estaba cancelada no hace nada y
  responde 200. 404 si no existe.
- `POST /jobs/reminders/run` → 200 `{ processed }`: recordatorios que **esta**
  pasada trató (enviados, reintentados o descartados).
- `POST /webhooks/inbound-messages { messageId, from, text, receivedAt }` → 200
  aunque se ignore el mensaje; 400 solo si el cuerpo no cumple el esquema.
- Recordatorio: `id`, `scheduledFor` (hora de envío tras aplicar las reglas),
  `status`, `attempts` (llamadas hechas al proveedor), `sentAt` (hora del
  servicio cuando el proveedor lo aceptó, o `null`), `skipReason` (o `null`).

### Reglas del recordatorio

1. Cada cita tiene un recordatorio para su hora actual.
2. **Hora de envío:** la misma hora local del día anterior, en la zona IANA de la
   clínica. Respeta los cambios de horario (último domingo de marzo y de
   octubre) y que Canarias va una hora por detrás. Ejemplo del enunciado: cita el
   28/03/2027 a las 10:00 de Madrid → recordatorio el 27/03/2027 a las 10:00 de
   Madrid (09:00 UTC), aunque entre ambos haya 23 horas.
3. **Horas de silencio:** entre las 21:00 y las 09:00 hora de la clínica no se
   envía nada; si la hora de envío cae ahí, pasa a las 09:00 siguientes.
4. **Ya pasó:** si al crear o reprogramar la hora de envío ya pasó, se usa la
   hora actual del servicio y se aplica igual la regla 3.
5. **too_late:** si con todo eso la hora de envío no queda antes del inicio de
   la cita, el recordatorio se **crea** ya como `skipped` con `too_late`. También
   queda `skipped`/`too_late` si al ir a enviarlo (primer intento o reintento) la
   cita ya empezó.
6. **Sin teléfono / dado de baja:** se evalúa **cuando le toca enviarse** (en el
   job, no al crear): queda `skipped` con `no_phone` u `opted_out` y no se llama
   al proveedor.
7. **Texto exacto**, con fecha y hora locales de la clínica:
   `Hola {nombre del paciente}, te recordamos tu cita en {nombre de la clínica} el {dd/MM/yyyy} a las {HH:mm}. Responde SI para confirmar o NO para cancelar.`
8. **Reprogramar:** el recordatorio pendiente pasa a `cancelled` y se crea otro
   para la nueva hora, **aunque el anterior ya se hubiera enviado** (el enviado se
   queda `sent`). Si la cita estaba `confirmed`, vuelve a `scheduled`.
9. **Cancelar** la cita cancela su recordatorio pendiente.

### Job de envío

- `POST /jobs/reminders/run` trata todos los recordatorios que tocan según el
  reloj del servicio, de todas las clínicas, y responde al terminar. En
  producción lo lanzaría un cron cada minuto.
- Puede haber varias pasadas a la vez (como varias instancias): cada
  recordatorio se envía una sola vez y **el proveedor no recibe dos llamadas para
  el mismo intento**.
- Respuestas del proveedor:
  - 202, o 200 (ya lo tenía y no lo reenvía): `sent`.
  - 503 (no se entregó): reintentar.
  - 504, error de red o más de 5 s sin respuesta (puede haberse entregado):
    reintentar sin que el paciente lo reciba dos veces, es decir, con la misma
    `Idempotency-Key`.
  - 422 (rechazado): `failed`, sin reintentos.
  - 400 no aparece en la tabla del enunciado (el proveedor lo da por petición
    inválida); ver «Ambigüedades».
- Reintentos: el 2.º intento va 1 minuto después del primer fallo y el 3.º,
  5 minutos después del 2.º. Si el 3.º también falla, `failed`. Los reintentos no
  esperan a que termine la franja de 21:00 a 09:00.

### Webhook `POST /webhooks/inbound-messages`

- SI confirma la cita; NO la cancela **junto con su recordatorio pendiente**.
  Tolera mayúsculas, tildes, espacios y signos alrededor (`Sí`, `si.`, `NO!`);
  cualquier otro texto se ignora.
- Se aplica a la cita que recibió el último recordatorio enviado a ese teléfono,
  entre las que no han empezado ni están canceladas (puede haber varios
  pacientes con el mismo número). Si no hay ninguna, se ignora.
- El mismo `messageId` puede llegar más de una vez: solo se procesa el primero.
- Responde 200 aunque ignore el mensaje (si respondiera error, el proveedor lo
  reenviaría); 400 solo con un cuerpo fuera de esquema.

### Estados

- Cita: `scheduled | confirmed | cancelled`.
- Recordatorio: `pending | sent | failed | skipped | cancelled`, con
  `skipReason` `too_late | no_phone | opted_out | null`.

### Entregables

- Repositorio público propio con historia real de commits (se evalúa el último
  commit subido antes del cierre del formulario).
- README: cómo levantarlo y pasar los tests; decisiones (arquitectura, cómo se
  evitan los envíos duplicados, cómo se tratan las zonas horarias y qué se
  descartó); qué quedó fuera y qué se haría con más tiempo; nota de producción
  de una página como mucho (500 clínicas, unos 20 000 recordatorios al día,
  proveedor real de WhatsApp, despliegue y monitorización); para qué se usó la IA
  y qué se corrigió de lo que propuso.
- Tests, tipos, lint, CI en GitHub Actions y las instrucciones para agentes
  (`AGENTS.md`, `CLAUDE.md` o similar).
- Peso: 30 % funciona (horas, envíos, fallos del proveedor, concurrencia y
  respuestas), 30 % arquitectura y código (reglas de negocio separadas de la
  infraestructura, errores bien tratados, código que otra persona entienda y
  cambie), 20 % entorno, 20 % criterio.

### Reunión informativa (2026-11-23)

Respuestas que no están en el PDF: el job procesa los recordatorios de todas
las clínicas; RLS por clínica es opcional; no hay datos de ejemplo (los tests
de evaluación crean los suyos); las citas virtuales usarían la hora de Madrid;
se recomendó, sin obligar, una arquitectura limpia. Se evalúa el último commit
subido antes del cierre (miércoles 25-11-2026, 17:30 de Madrid).

### Indicaciones del expositor y cómo se encajan

Lo dicho en la reunión tiene peso, siempre que no contradiga el enunciado.

| Indicación en la reunión | Relación con el enunciado | Cómo se incorpora |
|---|---|---|
| Citas virtuales con hora peninsular (Madrid) y la misma franja de silencio | No aparece; no lo contradice | Campo opcional `virtual` (por defecto `false`) en `POST /appointments`. La respuesta solo lo incluye cuando vale `true`, así que una cita creada sin el campo responde exactamente con la forma del contrato. Con `true`, hora de envío, franja y texto usan `Europe/Madrid`. Sin el campo, todo funciona como dice el contrato. |
| Reintentar cada minuto | Difiere del enunciado (1 min y 5 min, 3 intentos) | Se aplica el enunciado. Los retrasos viven en una sola constante del dominio y se cambian en una línea. Se cuenta en el README. |
| Si cae en la franja, a las 09:00 del día siguiente | Coincide entre 21:00 y 24:00; entre 00:00 y 09:00 el enunciado dice «las 09:00 siguientes» | Siempre la siguiente 09:00 local. |
| La clínica tiene su configuración (zona, horario de atención) | El contrato solo tiene `timezone` | Franja como constante del dominio; configuración por clínica en «qué haría con más tiempo». |
| Clave única para no duplicar; comprobar si un 504 se entregó antes de reintentar | Compatible | `Idempotency-Key` = id del recordatorio en todos sus intentos. El reintento con la misma clave es la comprobación: si ya se entregó, el proveedor responde 200 `duplicate`. |
| Rechazo del proveedor (lo nombró como 400) | El enunciado habla de 422 | 422 y cualquier otro 4xx dejan `failed` sin reintento. |
| Solo SI o NO; «sí, gracias» no cuenta | Compatible | Solo se quitan espacios y signos alrededor; test con «Sí, gracias». |
| Con teléfono compartido responde quien recibió el recordatorio | Compatible | Regla del último recordatorio enviado a ese teléfono. |
| El job es para todas las clínicas | Compatible | Sin filtro por clínica. |
| Arquitectura limpia, carpetas ordenadas, cuidar validaciones, respuestas y estados | Compatible | Capas `domain`, `application`, `infrastructure` y `http` (ver Decisiones). |
| Usar todos los tests posibles | Compatible | Unitarios del dominio, e2e con Postgres y proveedor reales, concurrencia y humo con `docker compose`. |
| CI en GitHub que valide cada cambio antes de aceptarlo | Compatible | Rama por tarea, PR a `main` y CI como check obligatorio. |
| Instrucciones para IA: `CLAUDE.md`, `AGENTS.md` y skills | Compatible | `AGENTS.md`, `CLAUDE.md` y una skill del proyecto. |
| Desplegar sin cortar a las clínicas y respetando las ejecuciones en curso | Compatible | Cierre ordenado: al recibir SIGTERM no se toman más recordatorios y se espera a la pasada en curso. Despliegue gradual y migraciones compatibles en la nota de producción. |
| Redis u otras herramientas para colas | Permitido | No hace falta: Postgres con `SKIP LOCKED` hace de cola. Redis o SQS en la nota de producción. |
| 3-4 horas como meta | Compatible | Primero el flujo principal; lo que falte se cuenta en el README. |
| 2 000 recordatorios al día | Difiere del enunciado (20 000) | La nota de producción usa 20 000. |

### Ambigüedades y cómo se resuelven (se cuentan en el README)

- **Citas virtuales:** campo opcional `virtual` (tabla anterior).
- **Reintentos:** 1 min y 5 min, 3 intentos en total. En el turno de preguntas se
  habló de cada minuto, pero en pantalla se resaltó la frase del enunciado.
- **Reloj de pruebas:** congelado hasta el siguiente `PUT`. Antes del primer
  `PUT` usa la hora del sistema.
- **Bordes de la franja:** `[21:00, 09:00)`; 21:00 en punto se mueve y 09:00 en
  punto se envía.
- **Horas que no existen o se repiten por el cambio de horario:** caen entre las
  02:00 y las 03:00, dentro de la franja, así que acaban en las 09:00.
- **Orden de los recordatorios con el reloj congelado:** ids UUIDv7 generados por
  la aplicación (llevan la hora de creación), y la lista se ordena por id.
- **«Último recordatorio enviado»:** número de envío de la secuencia de Postgres
  `reminder_send_seq`, asignado al marcar `sent`. No depende de `sentAt`, que
  empata con el reloj congelado.
- **Orden de los descartes en el job:** `too_late`, luego `no_phone`, luego
  `opted_out`.
- **Cancelar o reprogramar durante un envío:** esperan al bloqueo de la fila del
  recordatorio (5 s como mucho) y luego ven el estado final.
- **SI después de reprogramar:** confirma la cita con su hora nueva.
- **SI sobre una cita ya confirmada:** no cambia nada.
- **Ids que no son UUID** (en la ruta o en el cuerpo): 404, como un id que no
  existe.
- **Fechas en las respuestas:** UTC con `Z` y sin milisegundos cuando son cero
  (`2027-03-27T09:00:00Z`, como en el contrato).
- **Fechas de entrada sin zona** (`2027-03-28T10:00:00`): 400.
- **Zona de la clínica:** solo nombres IANA (`Europe/Madrid`, `Atlantic/Canary`).
  `local`, `system` y los offsets fijos (`+01:00`) dan 400: los dos primeros
  dependen de la máquina y un offset no tiene cambio de horario.
- **Orden de las comprobaciones:** 400 de esquema, luego 404, luego 409 y al
  final 400 de negocio (paciente de otra clínica, `startsAt` no futura).

## 2. Decisiones

- **El enunciado y el contrato mandan.** Lo que dijo el expositor se incorpora
  donde no los contradice (tabla «Indicaciones del expositor»).
- **Stack:**

  | Tema | Elección |
  |---|---|
  | Runtime | Node 24 (imagen `node:24-alpine`) y TypeScript `~6.0.3` (la plantilla trae `^6.0.2`; se fija la menor) |
  | Framework | Nest 12 en ESM con Express (plantilla por defecto de `nest new`) |
  | Validación | class-validator con un `ValidationPipe` global; un exception filter devuelve `{ "error": "..." }` |
  | Base de datos | Postgres 17 (`postgres:17-alpine`) con MikroORM 7 (`@mikro-orm/postgresql`, `@mikro-orm/nestjs`, `@mikro-orm/migrations`) |
  | Ids | UUIDv7 con el paquete `uuid` |
  | Fechas | Luxon, con todas las horas en `timestamptz` |
  | Proveedor | `fetch` nativo con `AbortSignal.timeout(5000)` |
  | Tests | Vitest (plantilla de Nest) y supertest; e2e contra Postgres real y `provider/server.mjs` real; el contrato se valida con Ajv (build 2020), `ajv-formats` y `yaml` (2026-11-24) |
  | Lint | oxlint `--type-aware` de la plantilla (`.oxlintrc.json`) con `typescript/no-floating-promises` como error y `typescript/no-explicit-any` activado; Prettier comprobado con `prettier --check` |
  | CI | GitHub Actions: lint, tipos, unitarios, e2e y humo con `docker compose` |

- **Arquitectura por capas con dependencias hacia dentro:**
  - `src/domain`: tipos y funciones puras. No importa Nest, MikroORM ni nada de
    E/S.
  - `src/application`: casos de uso (clases sin decoradores) y puertos (clases
    abstractas que Nest usa como token).
  - `src/infrastructure`: MikroORM, cliente HTTP del proveedor y relojes.
  - `src/http`: controladores finos, DTOs, presentadores y el filtro de errores.
  - Los casos de uso se registran en Nest con `useFactory`.
- **Persistencia:** las entidades de MikroORM se declaran con `defineEntity` sin
  clase y viven solo en `infrastructure`. Los repositorios traducen entre filas
  y tipos del dominio. Cada caso de uso abre una transacción explícita con el
  puerto `Transactions`, que ejecuta `em.fork().transactional(...)`. Las
  migraciones son SQL escrito a mano en clases `Migration` registradas en
  `migrationsList`, y corren antes de abrir el puerto.
- **Doble envío:** una transacción por recordatorio. Se toma con
  `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`), se vuelven a
  comprobar las reglas, se llama al proveedor con `Idempotency-Key` = id del
  recordatorio y se guarda el resultado antes del `COMMIT`. Un índice único
  parcial garantiza un solo recordatorio `pending` por cita.
- **Reloj:** puerto `Clock`. Ninguna regla usa `new Date()`, `Date.now()` ni
  `now()` de Postgres para la hora de negocio.
- **Ids (2026-11-24):** los genera el puerto `IdGenerator`, implementado con
  UUIDv7 del paquete `uuid` en `src/infrastructure/ids/`. No es una función de
  `src/domain` porque un UUIDv7 lee la hora del sistema y genera azar, y el
  dominio solo tiene funciones puras. `isId` sí vive en el dominio: acepta la
  forma canónica 8-4-4-4-12 en hexadecimal, que Postgres siempre puede
  convertir a `uuid`, así que un id raro da 404 y nunca 500.
- **Zonas válidas (2026-11-24):** `isValidTimeZone`, en
  `src/domain/time-zones.ts`, usa `IANAZone.isValidZone` de Luxon y rechaza
  además los offsets fijos, que Intl acepta como zona. La comprueba
  `CreateClinic`, que lanza `ValidationError`.
- **Base caída fuera de `/health` (2026-11-24):** `MikroOrmTransactions.run`
  convierte en `ServiceUnavailableError` (503) los errores de conexión
  (códigos de socket de pg-pool y SQLSTATE de conexión, apagado o sin
  conexiones libres). Mira solo el propio error y no su `cause`, para no
  confundir un `fetch` fallido con la base, y deja fuera `08P01`, que también
  lo provoca un dato con NUL. Lo demás sigue siendo 500: un 503 indica al
  cliente que reintente y solo es cierto si la base no responde.
- **Fechas de entrada (2026-11-24):** `@IsIsoDateTimeWithZone()` exige la
  forma `date-time` del contrato (RFC 3339, con los segundos opcionales):
  fecha completa con año de 4 cifras, hora 00-23 y zona `Z` u offset de
  ±23:59 como mucho; Luxon comprueba además que el día exista. El resto de lo
  que Luxon entiende como ISO 8601 es 400: con solo una hora completaría la
  fecha con la del sistema y no con la del reloj del servicio, a un mes sin
  día le pondría el 1, y un año de 5 cifras acababa en 500.
  `parseIsoDateTimeWithZone`, en el mismo archivo, convierte con el mismo
  parser y lanza en vez de completar una fecha.
- **Rango de fechas de entrada (2026-11-24):** una fecha de entrada (`startsAt`,
  `receivedAt`, `now` del reloj) tiene que caer en UTC entre los años 1 y
  9999; si no, es 400 de esquema con su propio mensaje. MikroORM envía las
  fechas con `toISOString()`: Postgres no tiene año 0 (`22008`) y lee el
  `+010000-…` de un año de 5 cifras como un offset (`22009`). Las dos
  pasaban el validador y acababan en 500 (reproducido); `PUT /test/clock`
  respondía 204, pero después el job y el webhook daban 500 en cada llamada.
  El reloj no se guarda, pero entra en esas consultas, así que lleva la misma
  regla. La comprobación está en `isIsoDateTimeWithZone`, que ya usan todos
  los DTO, y no en Postgres.
- **Textos de entrada (2026-11-24):** el decorador `@IsStorableText(máximo)`
  de `src/http/validation.ts` junta `@IsString()`, `@MaxLength()` y una regla
  sin el carácter NUL. Lo llevan los textos del cuerpo que se guardan o se
  consultan en Postgres: `name` de clínicas y pacientes, y `messageId` y
  `from` del webhook. Un NUL hacía que Postgres rechazara la consulta
  (`08P01`) y un `messageId` aleatorio de unos 2700 caracteres pasaba del
  máximo de una clave btree (2704 bytes, `54000`): 500 los dos
  (reproducido). Con 10 000 caracteres repetidos no fallaba, porque Postgres
  comprime la clave. Los límites están en `MAX_TEXT_LENGTH`, porque el
  contrato no fija ninguno:
  - `messageId`: 255. Tal como cuenta `@MaxLength`, un carácter ocupa como
    mucho 7 bytes en UTF-8 (emoji más selector de variante), así que 255 son
    unos 1,8 kB y caben en la clave. Un id de proveedor real tiene decenas de
    caracteres;
  - `name`: 200. Se guarda y va dentro del texto del recordatorio; ningún
    nombre real se acerca;
  - `from`: 200. No hace falta para la base (solo se compara con
    `sent_to`), pero así todo texto que llega a Postgres sigue la misma
    regla, y un teléfono en cualquier formato (`+34…`, `whatsapp:+34…`) queda
    muy por debajo. Sigue sin validarse como E.164.

  En el webhook también es 400 y no 200: el contrato reserva el 400 para un
  cuerpo fuera de esquema, y un mensaje con un `messageId` que no se puede
  guardar no se puede deduplicar. `text` se queda con `@IsString()`: no se
  guarda ni se consulta, y un texto con NUL se ignora con 200 como cualquier
  otro que no es SI ni NO. El resto de campos ya no llegaba a Postgres con un
  NUL: `timezone` no pasa `isValidTimeZone`, `phone` no pasa la expresión de
  E.164 y los ids no pasan `isId`.
- **Reprogramar y cancelar (2026-11-24):**
  - los dos casos de uso bloquean primero la cita (`FOR UPDATE`) y después
    sus pendientes (`FOR UPDATE` sin `SKIP LOCKED`). Dos `PATCH` a la vez se
    ponen en fila en la cita y el segundo cancela el pendiente que creó el
    primero; sin ese bloqueo, el segundo insertaba otro pendiente y el
    índice `reminder_one_pending` lo rechazaba con un 500 (reproducido).
    Cancelar sin bloquear la cita, con un `PATCH` esperando al job, perdía la
    hora nueva y dejaba un pendiente en la cita cancelada (reproducido). El
    webhook (tarea 8) sigue el mismo orden. El job (tarea 7) toma primero el
    recordatorio con `SKIP LOCKED`, así que no puede esperar después el
    bloqueo de la cita: la lee sin bloquearla, o la bloquea con `NOWAIT` o
    `SKIP LOCKED`, porque si no cerraría un ciclo con un `PATCH` y Postgres
    abortaría uno con `40P01`;
  - `PATCH` comprueba `isId` antes de abrir la transacción, como
    `GetAppointment`, y después cancelada o empezada (409) antes que
    `startsAt` no futura (400): una cita que no se puede reprogramar da 409
    aunque la hora nueva tampoco valga;
  - cancelar una cita que ya empezó responde 200 y la cancela: el contrato de
    `/cancel` solo prevé 200 y 404. Una ya cancelada se devuelve sin
    escribir;
  - los repositorios de citas y recordatorios leen sin identity map
    (`disableIdentityMap`). Escriben con sentencias directas, y con identity
    map una lectura posterior en la misma transacción devolvía la fila vieja
    (`findOne` ni consulta y `find` no pisa un valor con `null`).
- **Job de envío (2026-11-24):**
  - la pasada toma cada recordatorio con `lockNextDue` (`FOR UPDATE SKIP
    LOCKED`, por `next_attempt_at` e id) y lee cita, paciente y clínica sin
    bloquearlas (ver «Reprogramar y cancelar»). Una transacción por
    recordatorio, con la llamada al proveedor dentro y el resultado guardado
    antes del `COMMIT`; `sendSeq` se pide a `reminder_send_seq` solo al quedar
    `sent`;
  - `too_late` se mira con la hora del servicio antes de llamar; `sentAt` y
    la hora desde la que cuenta el reintento son la del servicio después de
    la llamada, porque `sentAt` es «cuando el proveedor lo aceptó» y el
    reintento va «1 minuto después del fallo». Con el reloj de test es la
    misma hora;
  - 200 y 202 son `sent`, y también cualquier otro 2xx: un proveedor real
    que acepte con 201 o 204 no debe dejar `failed` un mensaje entregado.
    Cualquier 4xx es `failed`, y lo demás (5xx, error de red, timeout, 1xx y
    3xx) se reintenta, que con la misma `Idempotency-Key` es seguro. El
    timeout (`AbortSignal.timeout`) cubre también la lectura del cuerpo;
  - error de red y timeout solo cuentan antes de las cabeceras
    (2026-11-24). En cuanto `fetch` resuelve, el resultado es el código: si
    la conexión se corta o salta el timeout a mitad del cuerpo, se registra
    y el código se mantiene. Antes el cuerpo se leía en el mismo `try`, y un
    422 con el cuerpo cortado acababa como `network_error` y se reintentaba
    al minuto, lo que podía entregar un mensaje que el operador había
    rechazado; un 202 en el mismo caso gastaba un intento de más
    (reproducido). La clasificación de `classifyProviderResult` no cambia:
    cambia qué resultado le llega;
  - `processed` cuenta lo que trató esa pasada: enviados, reintentados,
    fallidos y descartados. Un aplazado por la franja no cuenta (punto
    siguiente);
  - la franja de silencio también se mira al enviar (2026-11-24). La regla 3
    dice que entre las 21:00 y las 09:00 no se envía nada, y el enunciado
    solo exceptúa a los reintentos. Aplicarla solo al planificar dejaba
    salir un primer intento que el job tomaba dentro de la franja: un cron
    atrasado, una cola acumulada tras una caída o un `scheduledFor` justo
    antes de las 21:00 que se toma a las 21:00 (reproducido: la cita del
    11/03/2027 a las 10:00 de Madrid, creada a las 20:59:30 del día antes,
    salía con la pasada de las 21:00). Ahora, después de los descartes
    (`too_late`, `no_phone`, `opted_out`, que no llaman) y antes de llamar,
    `holdForQuietHours` mira si un recordatorio con `attempts` 0 cae en la
    franja de la zona efectiva (`effectiveTimeZone`, así que una cita
    virtual usa la de Madrid). Si cae, no se llama al proveedor:
    - sigue `pending`, con los mismos `attempts` y el mismo `scheduledFor`,
      y `next_attempt_at` pasa a las 09:00 siguientes (`quietHoursEnd`, que
      usa la misma lógica y la misma `QUIET_HOURS` que `planReminder`). Es
      lo que hace un reintento, y `scheduledFor` sigue diciendo la hora que
      se planificó;
    - si esas 09:00 no quedan antes del inicio de la cita, queda
      `skipped`/`too_late` ya, con la misma regla que al crearlo, en vez de
      esperar a una hora en la que la cita ya habrá empezado.

    El aplazado no cuenta en `processed`: el contrato lo define como los
    recordatorios que la pasada envió, reintentó o descartó, y este no es
    ninguno de los tres; contarlo haría que una pasada nocturna sin envíos
    respondiera como si hubiera trabajado. El `too_late` sí cuenta, porque
    es un descarte;
  - un error inesperado dentro de la transacción de un recordatorio
    (2026-11-24) deshace solo esa transacción. La pasada lo registra con su
    id, no lo cuenta en `processed`, no lo vuelve a tomar y sigue con los
    demás. Antes cortaba la pasada con un 500 y, como ese recordatorio va
    primero por `next_attempt_at`, también todas las siguientes (reproducido
    con una zona inválida puesta por SQL). Sigue `pending` con sus intentos
    anteriores y no se marca `failed`: el error pudo llegar después de que el
    proveedor lo aceptara, y la siguiente pasada lo repite con la misma clave
    sin duplicar el mensaje. Sí cortan la pasada la base caída
    (`ServiceUnavailableError`, 503) y un error antes de tomar ningún
    recordatorio, que si no se repetiría sin fin;
  - el id del recordatorio con error se apunta en los excluidos de la pasada
    en cuanto se bloquea, y no viaja en el error: envolver el error dentro de
    la transacción le ocultaría a `isDatabaseUnavailable`, que solo mira el
    propio error, que la base se ha caído. Se registra con un puerto `Logger`
    porque `src/application` no puede importar el de Nest;
  - el cierre ordenado aborta la señal y espera en
    `beforeApplicationShutdown`. En `onApplicationShutdown` llegaría tarde:
    antes Nest cierra el servidor HTTP, que espera a la petición del job, y
    la pasada sin abortar seguiría hasta vaciar la cola (reproducido: trataba
    2 recordatorios en vez de 1). Node ya espera a las peticiones HTTP en
    curso y el pool de `pg` a que la transacción suelte su conexión, pero el
    coordinador no depende de esos detalles.
- **Webhook (2026-11-24):**
  - una transacción por mensaje. Primero `insertIfNew` (`insert ... on
    conflict do nothing`): el `messageId` queda registrado junto con su
    efecto, y uno repetido no hace nada aunque la primera vez se ignorara.
    Después `parseReply` y, si es SI o NO, la búsqueda de la cita;
  - la cita sale de una sola consulta: recordatorio `sent` con `sent_to`
    igual a `from`, cita sin cancelar y con `starts_at` posterior a la hora
    del servicio, ordenado por `send_seq` descendente, `limit 1` y `FOR
    UPDATE OF` la cita. Si otra transacción tiene la cita, se espera; al
    confirmar, Postgres vuelve a evaluar la consulta con la fila nueva y, si
    ya no cumple (la cancelaron o ya empezó), pasa a la anterior que cumpla.
    El resultado es el mismo que si la otra transacción hubiera llegado
    antes. El caso de uso vuelve a comprobar `canReceiveReply` con la fila
    bloqueada, aunque con esta consulta nunca llega a descartar nada;
  - «no ha empezado» se mira con `Clock`. `receivedAt` solo se guarda;
  - NO bloquea los pendientes después de la cita, como cancelar: si el job
    está enviando uno, espera y, si queda `sent`, ya no lo cancela;
  - `from` no se valida como E.164: un teléfono sin envíos no encuentra cita
    y responde 200. El 200 va sin cuerpo, porque el contrato no define
    ninguno;
  - `parseReply` busca una sola palabra con una expresión anclada
    (`^[^\p{L}]*(\p{L}+)[^\p{L}]*$`) y no recorta los extremos con
    `^[^\p{L}]+|[^\p{L}]+$` y el flag `g`, como decía el plan: esa
    expresión retrocede en cada posición y un texto de 100 000 caracteres
    tardaba 10 s, con el proceso bloqueado (reproducido).
- **Test de contrato (2026-11-24):** `test/contract.e2e-spec.ts` valida cada
  respuesta contra `openapi.yaml` con `expectContract`
  (`test/support/contract.ts`), en vez de copiar sus valores a mano como los
  demás e2e, porque los tests de evaluación miden contra ese archivo. Es más
  estricto que el contrato, en una copia en memoria de sus esquemas, porque
  lo que el contrato deja abierto es justo donde un test oculto con
  `toEqual` fallaría:
  - `additionalProperties: false` en cada objeto con `properties`. La única
    excepción es `virtual` en `Appointment`, con `const: true` (tabla de
    indicaciones del expositor);
  - cada `date-time` lleva el patrón de `toApiDate` (UTC con `Z`, sin
    `.000`), que el contrato pide en `info.description` y que `format:
    date-time` no comprueba;
  - un 4xx es exactamente `{ "error": <string> }` con texto, la convención
    de `info.description`, aunque el contrato no le dé esquema;
  - una respuesta sin contenido va vacía (el 204 del reloj y el 200 del
    webhook, ver «Webhook»), salvo el `{ "status": "ok" }` que `/health` ya
    devolvía.

  Un código que la operación no documenta hace fallar el helper, así que no
  se usa con el 503 de la base caída ni con el 400 de `PUT /test/clock`, que
  el contrato no recoge; esos siguen en su e2e. El último test falla si
  alguna respuesta documentada no se ejercitó. Las dependencias son solo de
  desarrollo, y `ajv` y `ajv-formats` ya llegaban con `@nestjs/cli`.
- **Flujo de trabajo:**
  - Una rama por tarea del plan (`feat/...`), PR a `main` con el CI en verde y
    merge commit (sin squash) para conservar la historia real.
  - El repositorio público se crea cuando se autorice expresamente.
  - Commits en español con Conventional Commits, sin citas textuales. Los
    identificadores del código van en inglés; README, `AGENTS.md` y documentos
    en español.
- **Arquitectura de eventos (EventBridge, colas):** solo como propuesta en la
  nota de producción; el servicio entregado es una API REST con Postgres. Un
  `infra/` con Pulumi en TypeScript es opcional y solo al final.
- **Reglas de código (2026-11-24):** SOLID con inyección de dependencias,
  errores personalizados, `try/catch`, sin `any` y JSDoc en los métodos
  públicos (sección «Reglas de código» de `AGENTS.md`). Se adaptan al stack:
  - los errores personalizados son los de `src/application/errors.ts` y solo
    `ErrorFilter` los traduce a HTTP, porque los casos de uso son clases sin
    decoradores que no dependen de Nest y se prueban sin él;
  - `try/catch` solo en los límites con E/S, donde un fallo externo se
    convierte en un resultado tipado o en un error propio;
  - los tests siguen en Vitest y no se migra a Jest: es el runner de la
    plantilla de Nest 12 en ESM y tiene la misma API;
  - JSDoc se exige al código nuevo y a los archivos que se tocan; lo que quede
    sin documentar de la tarea 1 se repasa en la revisión previa a la tarea 9;
  - el formato de respuesta de un chat (solo un bloque de código) no se adopta:
    los agentes entregan en el repo, con `npm run verify` y PR.

## 3. Plan

# Recordatorios de citas · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API de clínicas, pacientes y citas que programa, envía (con reintentos
y sin duplicados) y procesa las respuestas de los recordatorios, según
`openapi.yaml`.

**Architecture:** Nest 12 como capa HTTP sobre casos de uso sin framework, que
usan funciones puras del dominio y puertos implementados con MikroORM y `fetch`.
El job es una transacción por recordatorio con `FOR UPDATE SKIP LOCKED`.

**Tech Stack:** Node 24, TypeScript 6.0, Nest 12 (ESM), MikroORM 7, Postgres 17,
Luxon, uuid (v7), class-validator, Vitest y supertest, GitHub Actions.

**Spec:** este mismo documento (secciones 1 y 2), `enunciado.pdf` y
`openapi.yaml`.

### Global Constraints

- Node ≥ 22 (se usa 24) y TypeScript `~6.0.3`.
- `docker compose up --build` levanta `api` en el puerto 3000 con
  `CLOCK_MODE=test` y `PROVIDER_URL=http://provider:4010`, más `db`. El bloque
  `provider` de `docker-compose.yml` no se toca.
- Errores: `{ "error": "<mensaje>" }`. Fechas de salida en UTC con `Z` (ver
  `toApiDate`).
- Texto exacto: `Hola {nombre del paciente}, te recordamos tu cita en {nombre de la clínica} el {dd/MM/yyyy} a las {HH:mm}. Responde SI para confirmar o NO para cancelar.`
- Franja de silencio `[21:00, 09:00)` local; reintentos a `[1, 5]` minutos, 3
  intentos como mucho; timeout del proveedor 5000 ms.
- E.164: `/^\+[1-9]\d{7,14}$/` (la misma regex que el proveedor).
- `src/domain` no importa `@nestjs/*`, `@mikro-orm/*` ni hace E/S; la hora
  siempre llega de `Clock`.
- Códigos: `POST /clinics`, `/patients` y `/appointments` → 201;
  `POST /appointments/{id}/cancel`, `/jobs/reminders/run` y
  `/webhooks/inbound-messages` → 200 (`@HttpCode(200)`); `PUT /test/clock` → 204.
- Cada tarea se hace en su rama y entra por PR con el CI en verde. Commits en
  español, sin citas textuales.

### Review Focus

1. **Formato de fechas:** el contrato muestra `2027-03-27T09:00:00Z`; si se
   devuelve `toISOString()` (`.000Z`), una comparación de texto falla. Test en la
   tarea 1 (`toApiDate`) y en la tarea 5 (respuesta de `POST /appointments`).
2. **Ids que no son UUID:** `GET /appointments/abc` o `clinicId: "x"` no pueden
   dar 500 por el cast de Postgres; deben dar 404. Tests en las tareas 3 y 5.
3. **Varios recordatorios creados en el mismo instante congelado:** reprogramar
   dos veces sin mover el reloj debe listar los recordatorios en orden de
   creación. Test en la tarea 6.
4. **Teléfono compartido con envíos en la misma pasada (mismo `sentAt`):** la
   respuesta debe ir a la cita enviada en último lugar. Test en la tarea 8.
5. **La cita empieza entre dos intentos:** el reintento queda `skipped`
   `too_late` sin llamar al proveedor y conserva `attempts`. Test en la tarea 7.

### Estructura de archivos

```
src/
  main.ts                         arranque: loadConfig + createApp + listen
  app.factory.ts                  createApp(config): pipes, filtro, migraciones, shutdown hooks
  app.module.ts                   AppModule.forRoot(config)
  config/app-config.ts            AppConfig y loadConfig(env)
  domain/                         tipos y funciones puras (una responsabilidad por archivo)
    ids.ts clinic.ts patient.ts appointment.ts reminder.ts time-zones.ts
    reminder-schedule.ts reminder-message.ts retry-policy.ts provider-outcome.ts patient-reply.ts
  application/
    errors.ts                     NotFoundError, ValidationError, ConflictError
    ports/                        clock.ts transactions.ts repositories.ts message-provider.ts
    clinics/ patients/ appointments/ reminders/ inbound/   un caso de uso por archivo
  infrastructure/
    clock/                        system-clock.ts test-clock.ts
    persistence/                  mikro-orm.config.ts entities.ts mikro-orm-transactions.ts
                                  repositories/*.ts migrations/*.ts persistence.module.ts
    provider/http-message-provider.ts
  http/
    error.filter.ts validation.ts api-date.ts presenters.ts shutdown-coordinator.ts
    *.controller.ts dto/*.ts
test/
  support/                        global-setup.ts app.ts provider-admin.ts fixtures.ts
  *.e2e-spec.ts
```

Los tests unitarios van junto al archivo (`*.spec.ts`).

### Task 0: Repositorio público (requiere autorización expresa)

- [x] **Step 1:** Pedir autorización para crear el repositorio público y subir
  `main`. No se hace nada en GitHub hasta tenerla.
- [x] **Step 2:** el clon apunta `origin` al repositorio de la prueba, así que
  primero `git remote rename origin upstream`. Después
  `gh repo create <usuario>/clinicsay-backend-challenge --public --source . --remote origin --push`
  y comprobar con `git ls-remote origin main` que coincide con `c5a8515`.

### Task 1: Andamiaje de Nest, reloj, errores y CI

Rama `feat/andamiaje`.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `nest-cli.json`, `.oxlintrc.json`, `.prettierrc`, `vitest.config.ts`,
  `vitest.config.e2e.ts`, `.nvmrc` (`24`), `.gitignore`
- Create: `src/main.ts`, `src/app.factory.ts`, `src/app.module.ts`,
  `src/config/app-config.ts`, `src/application/ports/clock.ts`,
  `src/infrastructure/clock/system-clock.ts`,
  `src/infrastructure/clock/test-clock.ts`, `src/http/error.filter.ts`,
  `src/http/validation.ts`, `src/http/api-date.ts`,
  `src/infrastructure/clock/test-clock.controller.ts` (adaptador de
  `TestClock`, por eso vive en `infrastructure`), `test/architecture.spec.ts`
- Create: `test/support/app.ts`, `test/test-clock.e2e-spec.ts`,
  `src/http/api-date.spec.ts`, `src/http/validation.spec.ts`
- Create: `.github/workflows/ci.yml`, `AGENTS.md`, `CLAUDE.md` (primera versión)

**Interfaces:**
- Produces:
  - `type ClockMode = 'test' | 'system'`;
    `interface AppConfig { port: number; databaseUrl: string; providerUrl: string; clockMode: ClockMode; providerTimeoutMs: number }`;
    `loadConfig(env: NodeJS.ProcessEnv): AppConfig` (por defecto `port` 3000 y
    `providerTimeoutMs` 5000; `clockMode` es `'test'` solo si
    `CLOCK_MODE === 'test'`).
  - `abstract class Clock { abstract now(): Date }`;
    `class SystemClock extends Clock`;
    `class TestClock extends Clock { set(now: Date): void }` (empieza en la hora
    del sistema).
  - `createApp(config: AppConfig): Promise<INestApplication>`.
  - `toApiDate(date: Date): string`.
  - `isIsoDateTimeWithZone(value: unknown): boolean` y el decorador
    `IsIsoDateTimeWithZone()`.
  - `startTestApp(overrides?: Partial<AppConfig>): Promise<TestApp>` con
    `TestApp = { http: ReturnType<typeof request>; app: INestApplication; setClock(iso: string): Promise<void>; close(): Promise<void> }`.

- [ ] **Step 1: Generar el proyecto.** `npx @nestjs/cli@12 new api --type esm --package-manager npm --skip-git`
  en un directorio temporal del scratchpad. Mover su contenido a la raíz sin
  pisar `provider/`, `openapi.yaml`, `docker-compose.yml`, `docs/`,
  `README.md`, `AGENTS.md` ni `CLAUDE.md`. Los `AGENTS.md` y `CLAUDE.md` de la
  plantilla (que remiten a `@nestjs/idempotency`, `@nestjs/resilience` y Nest
  Observe) se descartan; los del repo ya explican por qué no se usan. Borrar
  `AppController` y `AppService` de ejemplo. Scripts de `package.json`:
  `lint` (`oxlint --type-aware src/ test/` y `prettier --check`), `typecheck`
  (`tsc --noEmit`), `test`, `test:e2e`, `db:up`
  (`docker compose up -d --wait db`) y
  `verify` (`npm run lint && npm run typecheck && npm test && npm run test:e2e`). Fijar
  `"typescript": "~6.0.3"` y `"engines": { "node": ">=22" }`.
- [ ] **Step 2: Escribir los tests que fallan.**

```ts
// src/http/api-date.spec.ts
expect(toApiDate(new Date('2027-03-27T09:00:00.000Z'))).toBe('2027-03-27T09:00:00Z');
expect(toApiDate(new Date('2027-03-27T09:00:00.500Z'))).toBe('2027-03-27T09:00:00.500Z');
// src/http/validation.spec.ts
expect(isIsoDateTimeWithZone('2027-03-28T08:00:00Z')).toBe(true);
expect(isIsoDateTimeWithZone('2027-03-28T10:00:00+02:00')).toBe(true);
expect(isIsoDateTimeWithZone('2027-03-28T10:00:00')).toBe(false);
expect(isIsoDateTimeWithZone('2027-02-30T10:00:00Z')).toBe(false);
expect(isIsoDateTimeWithZone('mañana')).toBe(false);
expect(isIsoDateTimeWithZone(123)).toBe(false);
// test/test-clock.e2e-spec.ts
it('PUT /test/clock responde 204 en modo test')            // body { now: '2027-03-01T00:00:00Z' }
it('PUT /test/clock con now inválido responde 400 { error }') // expect(typeof res.body.error).toBe('string')
it('PUT /test/clock no existe sin CLOCK_MODE=test')         // startTestApp({ clockMode: 'system' }) → 404 con { error }
it('una ruta desconocida responde 404 { error }')
// test/architecture.spec.ts (lee los .ts de src/ y revisa sus imports)
it('src/domain no importa @nestjs, @mikro-orm, application, infrastructure ni http')
it('src/application no importa @mikro-orm, infrastructure ni http')
```

- [ ] **Step 3: Verlos fallar.** `npx vitest run src/http` y
  `npm run test:e2e -- test/test-clock.e2e-spec.ts`. Esperado: FAIL porque no
  existen los módulos.
- [ ] **Step 4: Implementar.**
  - `toApiDate` usa Luxon:
    `DateTime.fromJSDate(d, { zone: 'utc' }).toISO({ suppressMilliseconds: true })`
    y cambia `+00:00` por `Z`.
  - `isIsoDateTimeWithZone` exige `Z` u offset `±HH:MM` con la regex
    `/(Z|[+-]\d{2}:\d{2})$/` y que `DateTime.fromISO(value, { setZone: true }).isValid`.
  - El `ValidationPipe` global usa `whitelist: true` y `transform: true`, sin
    conversión implícita. Su `exceptionFactory` une los mensajes en un único
    `string`.
  - `ErrorFilter` (`@Catch()`) traduce `ValidationError` → 400,
    `NotFoundError` → 404, `ConflictError` → 409 y `HttpException` → su
    status con `{ error: message }`. Cualquier otro error da 500
    `{ error: 'internal error' }` y se registra en el log.
  - `TestClockController` solo se incluye en `AppModule` si
    `config.clockMode === 'test'`. El proveedor `Clock` usa `TestClock` en modo
    test y `SystemClock` en el resto.
  - `createApp` llama a `app.enableShutdownHooks()`.
- [ ] **Step 5: Verlos pasar** con los mismos comandos. Además `npm run lint` y
  `npx tsc --noEmit` sin errores.
- [ ] **Step 6: CI y agentes.**
  - `ci.yml` se dispara en `push` y en `pull_request` a `main`. Job `checks`
    sobre `ubuntu-latest` con Node 24: `npm ci`, `npm run lint`,
    `npx tsc --noEmit`, `npm test` y `npm run test:e2e`.
  - `AGENTS.md` y `CLAUDE.md` ya están redactados (ver Estado del
    2026-11-23). En esta tarea solo se ajustan a lo que exista de verdad:
    comandos, rutas del mapa de reglas y trampas del stack que se hayan
    confirmado o descartado.
- [ ] **Step 7: Commit, PR y merge** cuando el CI esté verde. Con el
  repositorio ya publicado, activar la protección de `main` con el check
  `checks` como obligatorio: `gh api -X PUT repos/<usuario>/<repo>/branches/main/protection`
  con `required_status_checks.contexts=["checks"]`.

### Task 2: Postgres, MikroORM, migraciones, health y Docker

Rama `feat/persistencia`.

**Files:**
- Create: `src/infrastructure/persistence/mikro-orm.config.ts`, `entities.ts`,
  `migrations/Migration20261123000000_initial.ts`, `persistence.module.ts`,
  `src/infrastructure/persistence/health.controller.ts` (usa MikroORM, así
  que no va en `http`)
- Create: `Dockerfile`, `.dockerignore`, `test/support/global-setup.ts`,
  `test/support/provider-admin.ts`, `test/health.e2e-spec.ts`
- Modify: `docker-compose.yml` (añadir `db` y `api`), `src/app.factory.ts`,
  `test/support/app.ts`, `vitest.config.e2e.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `AppConfig`, `createApp`, `startTestApp`.
- Produces:
  - `createOrmConfig(config: AppConfig)`.
  - Las entidades `ClinicEntity`, `PatientEntity`, `AppointmentEntity`,
    `ReminderEntity` e `InboundMessageEntity`, declaradas con `defineEntity`
    sin clase.
  - `TestApp` añade `orm: MikroORM`, `reset(): Promise<void>` (hace TRUNCATE de
    todas las tablas y `/admin/reset` en el proveedor) y
    `provider: ProviderAdmin`.
  - `ProviderAdmin = { rule(to: string, mode: 'unavailable' | 'lost-response' | 'reject', count: number): Promise<void>; messages(to: string): Promise<{ text: string; idempotencyKey: string }[]>; requests(to: string): Promise<{ idempotencyKey: string; status: number }[]> }`.

- [ ] **Step 1: Escribir el test que falla.**

```ts
// test/health.e2e-spec.ts
it('GET /health responde 200 con la base migrada', async () => {
  const res = await t.http.get('/health');
  expect(res.status).toBe(200);
  const tables = await t.orm.em.getConnection().execute(
    "select table_name from information_schema.tables where table_schema = 'public'");
  expect(tables.map((r) => r.table_name)).toEqual(
    expect.arrayContaining(['clinic', 'patient', 'appointment', 'reminder', 'inbound_message']));
});
```

- [ ] **Step 2: Verlo fallar** con `npm run test:e2e -- test/health.e2e-spec.ts`.
  Esperado: FAIL.
- [ ] **Step 3: Escribir la migración inicial con este SQL exacto.**

```sql
create table clinic (id uuid primary key, name text not null, timezone text not null);
create table patient (id uuid primary key, clinic_id uuid not null references clinic(id),
  name text not null, phone text null, accepts_reminders boolean not null);
create table appointment (id uuid primary key, clinic_id uuid not null references clinic(id),
  patient_id uuid not null references patient(id), starts_at timestamptz not null,
  status text not null check (status in ('scheduled','confirmed','cancelled')),
  virtual boolean not null default false);
create table reminder (id uuid primary key, appointment_id uuid not null references appointment(id),
  scheduled_for timestamptz not null,
  status text not null check (status in ('pending','sent','failed','skipped','cancelled')),
  skip_reason text null check (skip_reason in ('too_late','no_phone','opted_out')),
  attempts int not null default 0, next_attempt_at timestamptz null,
  sent_at timestamptz null, sent_to text null, send_seq bigint null);
create unique index reminder_one_pending on reminder (appointment_id) where status = 'pending';
create index reminder_due on reminder (next_attempt_at, id) where status = 'pending';
create index reminder_by_appointment on reminder (appointment_id, id);
create index reminder_last_sent on reminder (sent_to, send_seq desc) where status = 'sent';
create sequence reminder_send_seq;
create table inbound_message (message_id text primary key, received_at timestamptz not null);
```

- [ ] **Step 4: Implementar la persistencia y el arranque.**
  - Las entidades replican esas columnas con `p.uuid()`, `p.datetime()`,
    etc., y guardan los ids de las relaciones como propiedades escalares
    (`clinicId`, `appointmentId`...).
  - La configuración usa `extensions: [Migrator]`,
    `migrations: { migrationsList: [Migration20261123000000_initial] }` y
    `entities` explícitas.
  - `createApp` ejecuta `orm.migrator.up()` antes de devolver la app.
  - `HealthController` hace `select 1` y responde 200 `{ status: 'ok' }`, o 503
    si falla.
  - `global-setup.ts`:
    - crea la base `clinicsay_test` si no existe, conectando a `postgres` con
      `TEST_DATABASE_URL`, que por defecto es
      `postgres://clinicsay:clinicsay@localhost:5432/clinicsay_test`;
    - lanza `node provider/server.mjs` con `PORT=4011`, espera a su `/health` y
      lo detiene al terminar.
  - `vitest.config.e2e.ts` usa `fileParallelism: false`.
- [ ] **Step 5: Docker.**
  - `Dockerfile` en dos etapas sobre `node:24-alpine`: `npm ci`, `npm run build`
    y `npm prune --omit=dev`. Arranca con `CMD ["node", "dist/main.js"]` y tiene
    un `HEALTHCHECK` que hace `fetch('http://localhost:3000/health')` con `node -e`.
  - En `docker-compose.yml`:
    - `db`: `postgres:17-alpine`, con `POSTGRES_USER`, `POSTGRES_PASSWORD` y
      `POSTGRES_DB` en `clinicsay`, `pg_isready` como healthcheck y el puerto
      `5432:5432`.
    - `api`: `build: .`, `3000:3000`, `CLOCK_MODE=test`,
      `PROVIDER_URL=http://provider:4010` y
      `DATABASE_URL=postgres://clinicsay:clinicsay@db:5432/clinicsay`, con
      `depends_on` en `db` (`service_healthy`) y `provider`
      (`service_started`).
- [ ] **Step 6: Verificar.** `npm run test:e2e` pasa. Además
  `docker compose up --build -d --wait` y
  `curl -s -o /dev/null -w '%{http_code}' localhost:3000/health` devuelve
  `200`. Al final, `docker compose down -v`.
- [ ] **Step 7: CI.**
  - Al job `checks` se le añade el servicio `postgres:17-alpine` con
    `POSTGRES_DB=clinicsay_test` y la variable `TEST_DATABASE_URL`.
  - Job nuevo `compose`: `docker compose up --build -d --wait`, `curl` a
    `/health` y `docker compose down -v`.
  - El check `compose` pasa a ser obligatorio.
- [ ] **Step 8: Commit, PR y merge.**

### Task 3: Clínicas y pacientes

Rama `feat/clinicas-pacientes`.

**Files:**
- Create: `src/domain/ids.ts`, `src/domain/clinic.ts`, `src/domain/patient.ts`
  (con sus `*.spec.ts`)
- Create: `src/application/errors.ts`, `src/application/ports/transactions.ts`,
  `src/application/ports/repositories.ts`,
  `src/application/clinics/create-clinic.ts`,
  `src/application/patients/create-patient.ts`
- Create: `src/infrastructure/persistence/mikro-orm-transactions.ts`,
  `repositories/clinic.repository.ts`, `repositories/patient.repository.ts`
- Create: `src/http/clinics.controller.ts`, `src/http/patients.controller.ts`,
  `src/http/dto/create-clinic.dto.ts`, `src/http/dto/create-patient.dto.ts`,
  `src/http/presenters.ts`
- Create: `test/support/fixtures.ts`, `test/clinics-patients.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `newId(): string` (uuid v7); `isId(value: string): boolean` (valida un UUID).
  - `type Clinic = { id: string; name: string; timezone: string }`;
    `isValidTimeZone(tz: string): boolean`.
  - `type Patient = { id: string; clinicId: string; name: string; phone: string | null; acceptsReminders: boolean }`;
    `E164: RegExp`.
  - `abstract class Transactions { abstract run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> }`.
  - `interface Repositories { clinics: ClinicRepository; patients: PatientRepository }`.
    Las tareas siguientes añaden `appointments`, `reminders` e
    `inboundMessages`.
  - `ClinicRepository { findById(id: string): Promise<Clinic | null>; insert(c: Clinic): Promise<void> }`
    y lo mismo para `PatientRepository`.
  - `CreateClinic.execute(input: { name: string; timezone: string }): Promise<Clinic>`.
  - `CreatePatient.execute(input: { clinicId: string; name: string; phone: string | null; acceptsReminders: boolean }): Promise<Patient>`.
  - `fixtures.ts`: `createClinic(t, over?)` (por defecto
    `{ name: 'Clínica Dental Sonrisa', timezone: 'Europe/Madrid' }`) y
    `createPatient(t, clinicId, over?)` (por defecto
    `{ name: 'Ana', phone: '+34600111222', acceptsReminders: true }`).
    Ambas devuelven el body de la respuesta.

- [ ] **Step 1: Escribir los tests que fallan.**

```ts
// src/domain/clinic.spec.ts
expect(isValidTimeZone('Europe/Madrid')).toBe(true);
expect(isValidTimeZone('Atlantic/Canary')).toBe(true);
expect(isValidTimeZone('Europe/Narnia')).toBe(false);
// test/clinics-patients.e2e-spec.ts
it('POST /clinics → 201 { id, name, timezone }')
it('POST /clinics con zona inexistente → 400 { error }')      // timezone: 'Europe/Narnia'
it('POST /clinics sin name o con name "" → 400')
it('POST /clinics con JSON mal formado → 400 { error }')
it('POST /patients → 201 con phone null si no se envía')      // body sin phone → phone: null
it('POST /patients con phone "600111222" → 400')
it('POST /patients con acceptsReminders "true" (string) → 400')
it('POST /patients con clínica inexistente → 404')            // clinicId: newId()
it('POST /patients con clinicId que no es UUID → 404')        // clinicId: 'abc'
```

- [ ] **Step 2: Verlos fallar.**
- [ ] **Step 3: Implementar.**
  - Los DTOs usan `@IsString() @MinLength(1)` para `name`, `@IsString()` para
    `timezone` y `clinicId`, `@IsOptional() @Matches(E164)` para `phone` y
    `@IsBoolean()` para `acceptsReminders`.
  - `CreatePatient` lanza `NotFoundError` si `!isId(clinicId)` o si la clínica
    no existe.
  - `MikroOrmTransactions.run` hace `this.orm.em.fork().transactional((tx) => work(buildRepositories(tx)))`.
  - Los repositorios hacen `tx.insert(Entity, row)` y `tx.findOne(...)` y
    traducen la fila a un tipo del dominio.
- [ ] **Step 4: Verlos pasar** (`npx vitest run src/domain` y
  `npm run test:e2e`).
- [ ] **Step 5: Commit, PR y merge.**

### Task 4: Hora de envío y texto (dominio puro)

Rama `feat/horario-recordatorio`.

**Files:**
- Create: `src/domain/time-zones.ts`, `src/domain/reminder-schedule.ts`,
  `src/domain/reminder-message.ts` y sus `*.spec.ts`

**Interfaces:**
- Produces:
  - `VIRTUAL_TIME_ZONE = 'Europe/Madrid'`;
    `effectiveTimeZone(clinicTimeZone: string, virtual: boolean): string`.
  - `QUIET_HOURS = { start: 21, end: 9 } as const`.
  - `type ReminderPlan = { scheduledFor: Date; skipReason: 'too_late' | null }`.
  - `planReminder(input: { startsAt: Date; timeZone: string; now: Date }): ReminderPlan`.
  - `buildReminderText(input: { patientName: string; clinicName: string; startsAt: Date; timeZone: string }): string`.

- [ ] **Step 1: Escribir los tests que fallan** (tabla en
  `reminder-schedule.spec.ts`, con `now` por defecto `2027-03-01T00:00:00Z` y
  `timeZone` por defecto `Europe/Madrid`).

| Caso | startsAt | timeZone | now | scheduledFor | skipReason |
|---|---|---|---|---|---|
| Enunciado (23 h por el cambio de marzo) | `2027-03-28T08:00:00Z` | Madrid | — | `2027-03-27T09:00:00Z` | null |
| Canarias en el cambio de marzo | `2027-03-28T09:00:00Z` | `Atlantic/Canary` | — | `2027-03-27T10:00:00Z` | null |
| Cambio de octubre (25 h) | `2027-10-31T09:00:00Z` | Madrid | — | `2027-10-30T08:00:00Z` | null |
| Franja por la noche (22:30) | `2027-03-10T21:30:00Z` | Madrid | — | `2027-03-10T08:00:00Z` | null |
| Franja de madrugada (08:00) | `2027-03-10T07:00:00Z` | Madrid | — | `2027-03-09T08:00:00Z` | null |
| 21:00 en punto se mueve | `2027-03-10T20:00:00Z` | Madrid | — | `2027-03-10T08:00:00Z` | null |
| 09:00 en punto se envía | `2027-03-10T08:00:00Z` | Madrid | — | `2027-03-09T08:00:00Z` | null |
| Ya pasó → ahora | `2027-03-10T17:00:00Z` | Madrid | `2027-03-10T12:00:00Z` | `2027-03-10T12:00:00Z` | null |
| Ya pasó y ahora cae en la franja | `2027-03-11T09:00:00Z` | Madrid | `2027-03-10T21:30:00Z` | `2027-03-11T08:00:00Z` | null |
| too_late (09:00 no queda antes de las 08:30) | `2027-03-11T07:30:00Z` | Madrid | `2027-03-10T21:30:00Z` | `2027-03-11T08:00:00Z` | `too_late` |
| too_late por igualdad | `2027-03-11T08:00:00Z` | Madrid | `2027-03-10T21:30:00Z` | `2027-03-11T08:00:00Z` | `too_late` |

```ts
expect(effectiveTimeZone('Atlantic/Canary', true)).toBe('Europe/Madrid');
expect(effectiveTimeZone('Atlantic/Canary', false)).toBe('Atlantic/Canary');
expect(buildReminderText({ patientName: 'Ana', clinicName: 'Clínica Dental Sonrisa',
  startsAt: new Date('2027-03-28T08:00:00Z'), timeZone: 'Europe/Madrid' }))
  .toBe('Hola Ana, te recordamos tu cita en Clínica Dental Sonrisa el 28/03/2027 a las 10:00. Responde SI para confirmar o NO para cancelar.');
```

- [ ] **Step 2: Verlos fallar** con `npx vitest run src/domain`.
- [ ] **Step 3: Implementar `planReminder`.**

```
candidato = startsAt en timeZone, menos 1 día de calendario (Luxon minus({ days: 1 }))
si candidato < now → candidato = now en timeZone
si candidato.hour >= 21 → día siguiente a las 09:00:00.000
si candidato.hour < 9  → ese mismo día a las 09:00:00.000
skipReason = candidato < startsAt ? null : 'too_late'
```

  `buildReminderText` usa `toFormat('dd/MM/yyyy')` y `toFormat('HH:mm')` en la
  zona indicada.
- [ ] **Step 4: Verlos pasar.**
- [ ] **Step 5: Commit, PR y merge.**

### Task 5: Crear y ver citas (con `virtual`)

Rama `feat/citas`.

**Files:**
- Create: `src/domain/appointment.ts`, `src/domain/reminder.ts` (con sus
  `*.spec.ts`), `src/application/appointments/create-appointment.ts`,
  `src/application/appointments/get-appointment.ts`,
  `src/infrastructure/persistence/repositories/appointment.repository.ts`,
  `src/infrastructure/persistence/repositories/reminder.repository.ts`,
  `src/http/appointments.controller.ts`,
  `src/http/dto/create-appointment.dto.ts`, `test/appointments.e2e-spec.ts`
- Modify: `src/application/ports/repositories.ts`, `src/http/presenters.ts`,
  `test/support/fixtures.ts`

**Interfaces:**
- Consumes: `planReminder`, `effectiveTimeZone`, `Transactions`, `Clock`,
  `newId` e `isId`.
- Produces:
  - `type AppointmentStatus = 'scheduled' | 'confirmed' | 'cancelled'`.
  - `type Appointment = { id: string; clinicId: string; patientId: string; startsAt: Date; status: AppointmentStatus; virtual: boolean }`.
  - `type ReminderStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'cancelled'`;
    `type SkipReason = 'too_late' | 'no_phone' | 'opted_out'`.
  - `type Reminder = { id: string; appointmentId: string; scheduledFor: Date; status: ReminderStatus; skipReason: SkipReason | null; attempts: number; nextAttemptAt: Date | null; sentAt: Date | null; sentTo: string | null; sendSeq: number | null }`.
  - `newReminder(id: string, appointmentId: string, plan: ReminderPlan): Reminder`
    devuelve `pending` con `nextAttemptAt = scheduledFor`, o `skipped`
    `too_late` con `nextAttemptAt = null`.
  - `AppointmentRepository { findById(id): Promise<Appointment | null>; lockById(id): Promise<Appointment | null>; insert(a): Promise<void>; update(a): Promise<void> }`.
  - `ReminderRepository { listByAppointment(appointmentId): Promise<Reminder[]> /* orden por id asc */; insert(r): Promise<void>; update(r): Promise<void> }`.
  - `type AppointmentView = { appointment: Appointment; reminders: Reminder[] }`.
  - `CreateAppointment.execute(input: { clinicId: string; patientId: string; startsAt: Date; virtual: boolean }): Promise<AppointmentView>`.
  - `GetAppointment.execute(id: string): Promise<AppointmentView>`.
  - `fixtures.createAppointment(t, clinicId, patientId, startsAt, over?)`.

- [ ] **Step 1: Escribir los tests que fallan.**

```ts
// test/appointments.e2e-spec.ts (reloj en 2027-03-01T00:00:00Z salvo que se diga otra cosa)
it('POST /appointments → 201 con su recordatorio pendiente', async () => {
  // startsAt: '2027-03-28T10:00:00+02:00'
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ id: expect.any(String), clinicId, patientId,
    startsAt: '2027-03-28T08:00:00Z', status: 'scheduled',   // sin `virtual`
    reminders: [{ id: expect.any(String), scheduledFor: '2027-03-27T09:00:00Z',
      status: 'pending', attempts: 0, sentAt: null, skipReason: null }] });
});
it('GET /appointments/{id} devuelve lo mismo que el POST')
it('startsAt sin zona → 400')                         // '2027-03-28T10:00:00'
it('startsAt no futura → 400')                        // '2027-02-28T10:00:00Z'
it('paciente de otra clínica → 400')
it('clínica o paciente inexistentes → 404')
it('GET con id inexistente o que no es UUID → 404')   // newId() y 'abc'
it('se crea skipped too_late si no da tiempo')        // reloj 2027-03-10T21:30:00Z, startsAt 2027-03-11T07:30:00Z
it('virtual usa la hora de Madrid en una clínica de Canarias', async () => {
  // startsAt 2027-03-10T08:30:00Z: sin virtual → scheduledFor 2027-03-09T09:00:00Z; con virtual → 2027-03-09T08:30:00Z
  // con virtual: true, POST y GET devuelven `virtual: true`; sin él, la clave no aparece
});
```

- [ ] **Step 2: Verlos fallar.**
- [ ] **Step 3: Implementar.**
  - El DTO usa `@IsIsoDateTimeWithZone()` para `startsAt` y
    `@IsOptional() @IsBoolean()` para `virtual` (por defecto `false`).
  - Orden en `CreateAppointment`, dentro de una transacción:
    1. `isId` y existencia de la clínica y del paciente → 404;
    2. `patient.clinicId !== clinicId` → 400;
    3. `startsAt <= clock.now()` → 400;
    4. `planReminder` con `effectiveTimeZone`, y se insertan la cita y el
       recordatorio.
  - El presentador convierte cada fecha con `toApiDate` y no expone
    `nextAttemptAt`, `sentTo` ni `sendSeq`. Añade `virtual: true` solo si la
    cita es virtual; si no, la clave no aparece.
- [ ] **Step 4: Verlos pasar.**
- [ ] **Step 5: Commit, PR y merge.**

### Task 6: Reprogramar y cancelar

Rama `feat/reprogramar-cancelar`.

**Files:**
- Modify: `src/domain/appointment.ts`, `src/domain/reminder.ts` (y sus specs),
  `src/application/ports/repositories.ts`,
  `src/infrastructure/persistence/repositories/reminder.repository.ts`,
  `src/http/appointments.controller.ts`
- Create: `src/application/appointments/reschedule-appointment.ts`,
  `src/application/appointments/cancel-appointment.ts`,
  `src/http/dto/reschedule-appointment.dto.ts`,
  `test/reschedule-cancel.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `hasStarted(a: Appointment, now: Date): boolean` (`startsAt <= now`).
  - `rescheduleAppointment(a: Appointment, startsAt: Date): Appointment`
    (`confirmed` → `scheduled`).
  - `cancelAppointment(a: Appointment): Appointment`.
  - `confirmAppointment(a: Appointment): Appointment`.
  - `cancelReminder(r: Reminder): Reminder` (solo cambia si está `pending`;
    `nextAttemptAt = null`).
  - `ReminderRepository.lockPendingByAppointment(appointmentId: string): Promise<Reminder[]>`
    (`FOR UPDATE`, sin `SKIP LOCKED`).
  - `RescheduleAppointment.execute(id: string, startsAt: Date): Promise<AppointmentView>`.
  - `CancelAppointment.execute(id: string): Promise<AppointmentView>`.

- [ ] **Step 1: Escribir los tests que fallan.**

```ts
// src/domain/appointment.spec.ts
expect(rescheduleAppointment({ ...a, status: 'confirmed' }, d).status).toBe('scheduled');
expect(hasStarted({ ...a, startsAt: now }, now)).toBe(true);
// test/reschedule-cancel.e2e-spec.ts
it('reprogramar cancela el pendiente y crea otro', async () => {
  // cita 2027-03-28T08:00:00Z → PATCH startsAt 2027-03-29T08:00:00Z
  expect(res.body.reminders.map((r) => [r.status, r.scheduledFor])).toEqual([
    ['cancelled', '2027-03-27T09:00:00Z'], ['pending', '2027-03-28T08:00:00Z']]);
});
it('reprogramar después de enviado deja el anterior en sent')  // usa el job de la tarea 7; se añade en esa tarea
it('reprogramar dos veces en el mismo instante conserva el orden de creación', async () => {
  expect(statuses).toEqual(['cancelled', 'cancelled', 'pending']);
});
it('PATCH de una cita cancelada → 409; de una que ya empezó → 409')
it('PATCH con startsAt no futura → 400; inexistente o no UUID → 404')
it('cancelar → 200 cancelled y el pendiente cancelled; repetirlo → 200 sin cambios')
it('cancelar inexistente → 404')
```

- [ ] **Step 2: Verlos fallar.**
- [ ] **Step 3: Implementar.**
  - Ambos casos de uso, en una transacción: `appointments.lockById` (404 si no
    hay), luego `reminders.lockPendingByAppointment`, y después aplican las
    funciones del dominio.
  - Reprogramar comprueba: cancelada o `hasStarted` → 409; `startsAt <= now`
    → 400. Luego crea el recordatorio nuevo con `planReminder`.
  - Cancelar una cita ya cancelada devuelve la vista sin escribir nada.
- [ ] **Step 4: Verlos pasar.**
- [ ] **Step 5: Commit, PR y merge.**

### Task 7: Job de envío, reintentos, concurrencia y cierre ordenado

Rama `feat/job-envio`.

**Files:**
- Create: `src/domain/retry-policy.ts`, `src/domain/provider-outcome.ts` (y
  sus specs), `src/application/ports/message-provider.ts`,
  `src/application/reminders/run-reminder-pass.ts`,
  `src/infrastructure/provider/http-message-provider.ts`,
  `src/http/jobs.controller.ts`, `src/http/shutdown-coordinator.ts`,
  `test/reminder-job.e2e-spec.ts`
- Modify: `src/domain/reminder.ts` (y su spec),
  `src/application/ports/repositories.ts`,
  `src/infrastructure/persistence/repositories/reminder.repository.ts`,
  `test/reschedule-cancel.e2e-spec.ts` (el caso «después de enviado»)

**Interfaces:**
- Produces:
  - `RETRY_DELAYS_MINUTES = [1, 5] as const`;
    `MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1`;
    `nextRetryAt(attemptsMade: number, failedAt: Date): Date | null`.
  - `type ProviderResult = { kind: 'response'; status: number } | { kind: 'network_error' } | { kind: 'timeout' }`.
  - `type SendOutcome = 'delivered' | 'retry' | 'rejected'`;
    `classifyProviderResult(r: ProviderResult): SendOutcome`.
  - `skipReasonAtSendTime(input: { startsAt: Date; now: Date; phone: string | null; acceptsReminders: boolean }): SkipReason | null`.
  - `skipReminder(r: Reminder, reason: SkipReason): Reminder`.
  - `recordAttempt(r: Reminder, outcome: SendOutcome, ctx: { now: Date; to: string; sendSeq: number | null }): Reminder`.
    Siempre suma 1 a `attempts`. `delivered` → `sent` con `sentAt = now`,
    `sentTo`, `sendSeq` y `nextAttemptAt = null`. `rejected` → `failed`.
    `retry` → `pending` con `nextAttemptAt = nextRetryAt(...)`, o `failed` si
    devuelve `null`.
  - `abstract class MessageProvider { abstract send(msg: { idempotencyKey: string; to: string; text: string }): Promise<ProviderResult> }`.
  - `ReminderRepository.lockNextDue(now: Date, excludeIds: string[]): Promise<Reminder | null>`
    (`status = 'pending'`, `next_attempt_at <= now`, `id not in excludeIds`,
    ordenado por `next_attempt_at, id`, con `PESSIMISTIC_PARTIAL_WRITE`).
  - `ReminderRepository.nextSendSequence(): Promise<number>`
    (`select nextval('reminder_send_seq')`).
  - `RunReminderPass.execute(signal?: AbortSignal): Promise<{ processed: number }>`.
  - `ShutdownCoordinator { signal: AbortSignal; track<T>(p: Promise<T>): Promise<T> }`,
    que en `onApplicationShutdown` aborta y espera a lo que esté en curso.

- [ ] **Step 1: Escribir los tests unitarios que fallan.**

```ts
expect(nextRetryAt(1, new Date('2027-03-27T09:00:00Z'))).toEqual(new Date('2027-03-27T09:01:00Z'));
expect(nextRetryAt(2, new Date('2027-03-27T09:01:00Z'))).toEqual(new Date('2027-03-27T09:06:00Z'));
expect(nextRetryAt(3, new Date('2027-03-27T09:06:00Z'))).toBeNull();
// classifyProviderResult: 202/200 → delivered; 503/504/500/network_error/timeout → retry; 422/400 → rejected
// skipReasonAtSendTime: empezó (startsAt <= now) → too_late aunque además falte phone; phone null → no_phone; acceptsReminders false → opted_out
```

- [ ] **Step 2: Escribir los e2e que fallan.** Todos parten de una cita el
  `2027-03-28T08:00:00Z` en Madrid, con el teléfono `+34600111222` y el envío
  previsto `T = 2027-03-27T09:00:00Z`.

```ts
it('envía a su hora: sent, attempts 1, sentAt T y texto exacto', async () => {
  await t.setClock('2027-03-27T09:00:00Z');
  expect((await t.http.post('/jobs/reminders/run')).body).toEqual({ processed: 1 });
  // reminders[0]: { status: 'sent', attempts: 1, sentAt: '2027-03-27T09:00:00Z' }
  expect(await t.provider.messages('+34600111222')).toHaveLength(1); // text === buildReminderText(...)
});
it('antes de su hora no se procesa')                           // reloj 2027-03-27T08:59:59Z → { processed: 0 }
it('503 y reintento al minuto')                                // rule unavailable 1 → pending attempts 1; T+1min → sent attempts 2
it('504 con entrega perdida no duplica')                       // rule lost-response 1 → T+1min: sent; messages = 1; requests = 2 con la misma idempotencyKey
it('tres fallos → failed; el tercero no sale antes de T+6min') // unavailable 3; en T+5min59s → processed 0; en T+6min → failed attempts 3
it('422 → failed con attempts 1 y sin más llamadas')
it('sin teléfono → skipped no_phone y opted_out → skipped opted_out, sin llamadas al proveedor')
it('la cita empieza entre intentos → skipped too_late sin llamar', async () => {
  // reloj 2027-03-10T10:00:00Z, cita 2027-03-10T10:00:30Z, unavailable 1 → run; reloj 2027-03-10T10:01:00Z → run
  // reminders[0]: { status: 'skipped', skipReason: 'too_late', attempts: 1 }; requests = 1
});
it('5 pasadas concurrentes envían 10 recordatorios una sola vez', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => t.http.post('/jobs/reminders/run')));
  expect(results.reduce((s, r) => s + r.body.processed, 0)).toBe(10);
  // para cada uno de los 10 teléfonos: requests(to).length === 1
});
it('con la señal abortada no toma ningún recordatorio')        // RunReminderPass desde el contenedor con AbortSignal.abort() → { processed: 0 } y sigue pending
```

  En `reschedule-cancel.e2e-spec.ts`, completar el caso «reprogramar después de
  enviado»: los recordatorios quedan `['sent', 'pending']`.
- [ ] **Step 3: Verlos fallar.**
- [ ] **Step 4: Implementar `RunReminderPass`.**

```
processed = 0; seen = []
mientras no signal.aborted:
  handled = transactions.run(repos =>
    r = repos.reminders.lockNextDue(clock.now(), seen); si no hay → false
    cita, paciente y clínica por id; now = clock.now()
    reason = skipReasonAtSendTime(...) → si hay: update(skipReminder(r, reason)); true
    tz = effectiveTimeZone(clinic.timezone, cita.virtual)
    result = provider.send({ idempotencyKey: r.id, to: phone, text: buildReminderText(...) })
    outcome = classifyProviderResult(result)
    seq = outcome === 'delivered' ? repos.reminders.nextSendSequence() : null
    update(recordAttempt(r, outcome, { now, to: phone, sendSeq: seq })); seen.push(r.id); true)
  si !handled → salir; processed++
```

  - `HttpMessageProvider` hace POST a `${providerUrl}/messages` con
    `Idempotency-Key` y `content-type: application/json`, y
    `signal: AbortSignal.timeout(providerTimeoutMs)`. Un `TimeoutError` es
    `timeout` y cualquier otro error de `fetch` es `network_error`.
  - El controlador ejecuta
    `coordinator.track(pass.execute(coordinator.signal))` y responde 200.
- [ ] **Step 5: Verlos pasar** con `npm test` y `npm run test:e2e`.
- [ ] **Step 6: Commit, PR y merge.**

### Task 8: Webhook de respuestas

Rama `feat/webhook`.

**Files:**
- Create: `src/domain/patient-reply.ts` (y su spec),
  `src/application/inbound/handle-inbound-message.ts`,
  `src/infrastructure/persistence/repositories/inbound-message.repository.ts`,
  `src/http/webhooks.controller.ts`, `src/http/dto/inbound-message.dto.ts`,
  `test/webhook.e2e-spec.ts`
- Modify: `src/application/ports/repositories.ts`,
  `src/infrastructure/persistence/repositories/appointment.repository.ts`

**Interfaces:**
- Produces:
  - `parseReply(text: string): 'yes' | 'no' | null`.
  - `InboundMessageRepository.insertIfNew(messageId: string, receivedAt: Date): Promise<boolean>`
    (`insert ... on conflict do nothing`; devuelve `true` si insertó).
  - `AppointmentRepository.lockLatestRepliable(phone: string, now: Date): Promise<Appointment | null>`.
    Busca la cita del recordatorio `sent` con `sent_to = phone`, cuya cita no
    esté `cancelled` y tenga `starts_at > now`, ordenado por `send_seq desc`
    con `limit 1`, y bloquea la fila de la cita con `FOR UPDATE`.
  - `HandleInboundMessage.execute(input: { messageId: string; from: string; text: string; receivedAt: Date }): Promise<void>`.

- [ ] **Step 1: Escribir los tests que fallan.**

```ts
// patient-reply.spec.ts
for (const t of ['Sí', 'si.', 'SI', '  sí  ', '¡SÍ!']) expect(parseReply(t)).toBe('yes');
for (const t of ['NO!', 'no', 'No.']) expect(parseReply(t)).toBe('no');
for (const t of ['Sí, gracias', 'sip', 'n o', '', 'SI NO']) expect(parseReply(t)).toBeNull();
// test/webhook.e2e-spec.ts (tras enviar el recordatorio como en la tarea 7)
it('SI confirma la cita')
it('NO cancela la cita y su recordatorio pendiente')       // reprogramar tras el envío → NO → cita cancelled, nuevo cancelled
it('el mismo messageId solo se procesa una vez')           // SI (m1) → PATCH (vuelve a scheduled) → SI (m1) → sigue scheduled
it('SI y luego reprogramar deja la cita scheduled')
it('«Sí, gracias» se ignora con 200')
it('teléfono sin citas → 200 y nada cambia')
it('teléfono compartido en la misma pasada: aplica a la última enviada', async () => {
  // dos pacientes con +34600111222, citas A (creada antes) y B; un run las envía con el mismo sentAt
  // NO → B cancelled, A scheduled
});
it('ignora citas que ya empezaron y cae en la anterior si la última está cancelada')
it('cuerpo sin messageId → 400 { error }')
```

- [ ] **Step 2: Verlos fallar.**
- [ ] **Step 3: Implementar.**
  - `parseReply`: `normalize('NFD')`, quitar `\p{M}`, quitar
    `^[^\p{L}]+|[^\p{L}]+$` (con flag `u`), pasar a minúsculas y comparar con
    `si` o `no`.
  - En una transacción: si `insertIfNew` devuelve `false` → fin. Si
    `parseReply` da `null` → fin. Si `lockLatestRepliable` no encuentra cita →
    fin.
    - `yes` → `confirmAppointment`.
    - `no` → `cancelAppointment` y `cancelReminder` sobre
      `lockPendingByAppointment`.
  - Siempre responde 200.
- [ ] **Step 4: Verlos pasar.**
- [ ] **Step 5: Commit, PR y merge.**

### Task 9: Entrega: README, nota de producción, agentes y humo

Rama `docs/entrega`.

**Files:**
- Create: `scripts/smoke.sh`, `.claude/skills/verificar/SKILL.md`
- Modify: `README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/workflows/ci.yml`,
  `docs/2026-11-23-recordatorios-design.md` (Estado)

- [ ] **Step 1: `scripts/smoke.sh`.** Con `docker compose` levantado, recorre:
  `PUT /test/clock` → crear clínica → paciente → cita → mover el reloj a la hora
  de envío → `POST /jobs/reminders/run` → comprobar `{"processed":1}` y un
  mensaje en `localhost:4010/admin/messages`. Sale con código distinto de 0 si
  algo no cuadra. El job `compose` del CI lo ejecuta.
- [ ] **Step 2: README** con los apartados que pide el enunciado:
  1. cómo levantarlo y pasar los tests;
  2. decisiones: arquitectura, duplicados, zonas horarias, qué se descartó y
     las ambigüedades de la sección 1;
  3. qué quedó fuera;
  4. nota de producción de una página: 20 000 recordatorios al día con el pico
     de las 09:00 que provoca la franja, cron cada minuto con varias réplicas
     sobre `SKIP LOCKED`, la evolución a reserva con `locked_until` u outbox con
     cola, plantillas y ventana de 24 h de WhatsApp, firma del webhook,
     despliegue gradual con cierre ordenado y migraciones compatibles, y
     métricas y alertas (retraso entre `scheduledFor` y `sentAt`, tasas de
     `failed`/`skipped`, latencia y errores del proveedor);
  5. uso de la IA y qué se corrigió.
- [ ] **Step 3: Versión final de `AGENTS.md`, `CLAUDE.md` y de la skill
  `verificar`**, que ejecuta lint, tipos, tests unitarios, e2e y el humo.
- [ ] **Step 4: Verificar.** `npm run lint && npx tsc --noEmit && npm test && npm run test:e2e`
  sin errores. Además `docker compose up --build -d --wait && ./scripts/smoke.sh`
  termina con código 0.
- [ ] **Step 5: Commit, PR y merge.** Actualizar Estado con los enlaces a las
  PR.

## 4. Estado

- 2026-11-23: repositorio base clonado (commit `c5a8515`), sin cambios propios
  ni repositorio público todavía.
- 2026-11-23: leídos `enunciado.pdf`, `openapi.yaml`, `provider/server.mjs` y
  `docker-compose.yml`; corregido el resumen de la sección 1 (contrato,
  `no_phone`/`opted_out` evaluados al enviar, reprogramar aunque ya se hubiera
  enviado, NO cancela también el recordatorio, webhook con 400 por esquema,
  reloj sin modo test = 404, «dos llamadas para el mismo intento») y listadas
  las ambigüedades. Siguiente paso: decidir tecnologías y escribir el plan.
- 2026-11-23: decidido el stack (Nest 12 en ESM, MikroORM 7, Vitest), el campo
  opcional `virtual` y el trabajo con ramas, PR y CI obligatorio. Añadidas la
  tabla de indicaciones del expositor, las ambigüedades resueltas y el plan
  (tareas 0 a 9). Sin código ni commits todavía. Siguiente paso: revisar el
  plan y autorizar la tarea 0 (crear el repositorio público).
- 2026-11-23: redactados `AGENTS.md` y `CLAUDE.md` (sin commit) a partir de
  las reglas y los incidentes de otros proyectos, y revisados por un segundo
  modelo. `AGENTS.md` lleva un
  mapa regla → archivo → test, un protocolo de cambio, `npm run verify` como
  definición de terminado, los invariantes con su porqué y las trampas del
  stack. `CLAUDE.md` importa `AGENTS.md` y solo añade lo propio de Claude Code.
  La revisión corrigió el plan:
  - la plantilla de Nest 12 en ESM usa oxlint, no ESLint;
  - la plantilla genera su propio `AGENTS.md`/`CLAUDE.md`, que no deben pisar
    los del repo;
  - los controladores de `/health` y `/test/clock` pasan a `infrastructure`,
    porque usan MikroORM y `TestClock`;
  - se añaden `test/architecture.spec.ts` y los scripts `verify`, `typecheck`
    y `db:up`.

  Además se decidió que la respuesta solo incluya `virtual` cuando vale
  `true`, para que los tests contra el contrato no vean campos de más. Los
  commits y las PR no llevan atribución de herramienta; el uso de IA se cuenta
  en el README. Siguiente paso: autorizar la tarea 0.
- 2026-11-24: tarea 0 hecha. Repositorio público
  https://github.com/aarondevl/clinicsay-backend-challenge con `main` en
  `c5a8515` (comprobado con `git ls-remote origin main`); el repositorio de la
  prueba queda como `upstream`. `AGENTS.md`, `CLAUDE.md` y `docs/` siguen sin
  commit y entran con la PR de la tarea 1. Siguiente paso: tarea 1, rama
  `feat/andamiaje`.
- 2026-11-24: tarea 1 implementada en `feat/andamiaje`. Cambios respecto al
  plan:
  - `TestClockController` vive en `src/http` y fija la hora con el puerto
    `SettableClock` de `application`; en `infrastructure` habría necesitado el
    validador de `src/http`, que esa capa no puede importar;
  - `src/application/errors.ts` se crea ya aquí porque el filtro de errores
    lo usa (el plan lo ponía en la tarea 3);
  - se descartan de la plantilla `@nestjs/observe`, `@nestjs/mau`, el script
    `deploy` y las skills genéricas de `.claude/` y `.agents/`;
  - tests añadidos al brief: `loadConfig`, `TestClock` congelado y JSON mal
    formado → 400 `{ error }`.
- 2026-11-24: tarea 1 mergeada (PR #1, `main` en `7812ae5`). Añadidas las
  reglas de código (sección 2 y «Reglas de código» de `AGENTS.md`, con
  resumen en `README.md` y `CLAUDE.md`); solo documentación. Siguiente paso:
  ola 1, tareas 2 y 4 en paralelo.
- 2026-11-24: tarea 4 implementada en `feat/horario-recordatorio`. Entran
  `src/domain/time-zones.ts` (`VIRTUAL_TIME_ZONE`, `effectiveTimeZone`,
  `localDateTime`), `reminder-schedule.ts` (`QUIET_HOURS`, `ReminderPlan`,
  `planReminder`) y `reminder-message.ts` (`buildReminderText`), con 22
  unitarios. Cambios respecto al plan:
  - `localDateTime` pasa un instante a la hora local y lanza un `Error` simple
    si la zona no es válida; sin esa guarda Luxon devolvía una fecha inválida
    y `too_late` sin avisar. No es un error propio porque `src/domain` no
    puede importar `application` (`test/architecture.spec.ts`) y una zona
    inválida es un fallo de programación: la valida la tarea 3 al crear la
    clínica;
  - tests añadidos a la tabla del plan: hora que no existe el día del cambio
    de marzo, hora repetida el de octubre, franja que salta al día del cambio,
    texto en Canarias, ceros a la izquierda y zona inválida;
  - `isValidTimeZone` queda para la tarea 3;
  - la tarea no mergea su PR: queda para revisión.

  La revisión final de la rama no encontró nada grave. Queda para otro
  cambio:
  - `outOfQuietHours` supone una franja que cruza la medianoche
    (`start > end`); una franja dentro del mismo día necesita otra condición;
  - el mensaje de `localDateTime` habla de la zona aunque lo inválido sea la
    fecha, y la guarda acepta `local` o `system` como zona: la tarea 3 debería
    validar con `IANAZone.isValidZone`;
  - faltan casos de «ya pasó» con `now` de madrugada y con milisegundos (el
    comportamiento es correcto);
  - `AGENTS.md` dice que `domain` lanza los errores de
    `src/application/errors.ts`, pero `test/architecture.spec.ts` no le deja
    importar `application`; y el plan pone `isValidTimeZone` junto a `Clinic`
    mientras el mapa de `AGENTS.md` la sitúa en `time-zones.ts`.

  Verificación: `npm run lint && npm run typecheck && npm test` en verde
  (8 archivos, 37 tests); los e2e y `docker compose` los corre el CI.
  Siguiente paso: revisar y mergear la PR; la tarea 5 consume `planReminder`,
  `buildReminderText` y `effectiveTimeZone`.
- 2026-11-24: tarea 2 implementada en `feat/persistencia`. Entran MikroORM 7
  (`@mikro-orm/core`, `postgresql`, `migrations` y `nestjs`), las entidades con
  `defineEntity`, la migración inicial con el SQL del plan, las migraciones en
  `createApp` antes de abrir el puerto, `GET /health` (200, o 503 si la base no
  responde), el `Dockerfile`, los servicios `db` y `api` del compose, el
  `globalSetup` de los e2e (base `clinicsay_test` y proveedor en el 4011),
  `TestApp` con `orm`, `provider` y `reset()`, y en el CI Postgres para
  `checks` y el job `compose`. Cambios respecto al plan:
  - el 503 de `/health` sale de un error propio nuevo, `ServiceUnavailableError`,
    que traduce `ErrorFilter`, para que el controlador no elija códigos HTTP;
  - `MikroOrmModule` va con `registerRequestContext: false`: sin contexto por
    petición, usar el `EntityManager` global falla y obliga a pasar por
    `Transactions`;
  - la base de test se crea con `orm.schema.ensureDatabase()` de MikroORM en
    vez de abrir a mano una conexión a `postgres`: mismo efecto, sin importar
    `pg` directamente;
  - `ProviderAdmin` añade `reset()`, y `TestApp.provider` apunta siempre al
    proveedor de test aunque se cambie `providerUrl`, para que `reset()` sirva
    también en los tests con un puerto cerrado;
  - tests añadidos: 503 al cortar un proxy TCP entre la app y Postgres, y en
    `test/persistence.e2e-spec.ts` el índice `reminder_one_pending`, el
    `check` del estado y `reset()`;
  - la migración solo tiene `up()`;
  - tras la revisión final, `db` se publica en `127.0.0.1:55432` y no en
    `5432:5432` como decía el plan: con un Postgres local en el 5432,
    `docker compose up` no arrancaba (reproducido). La api no necesita ese
    puerto;
  - el healthcheck de `db` usa `pg_isready -h 127.0.0.1`: por socket daba por
    lista la base durante el servidor temporal de la primera inicialización,
    que no escucha por TCP (reproducido), y la api podía salir sin reintento.
    Además, `api` lleva `restart: on-failure`.

  La revisión dejó para otro cambio: `/health` no comprueba que las
  migraciones sigan aplicadas si la base se recrea en caliente; el pool no
  tiene `connectionTimeoutMillis`, así que `/health` puede quedarse esperando
  con el pool agotado; `reset()` vacía las tablas que tienen entidad, no las
  de `pg_tables`; `ProviderAdmin.requests()` no admite `idempotencyKey: null`;
  si `app.close()` falla tras una migración fallida se pierde el error
  original; y `registerRequestContext: false` solo se explica en
  `persistence.module.ts`. Para la tarea 7 sugirió un modo del proxy TCP que
  acepte y no responda (timeout determinista) y abortar el job en
  `beforeApplicationShutdown`, que llega antes de que Nest cierre MikroORM.

  Verificación: `npm run verify` en verde tras el merge de `main` (8 archivos
  y 38 unitarios, 3 archivos y 10 e2e); `docker compose up --build -d --wait`
  con el 5432 del host ocupado, `/health` en 200, 503 al parar `db` y 200 al
  volver. Siguiente paso: revisar y mergear la PR y, después, `compose` como
  check obligatorio de `main`; luego la tarea 3.
- 2026-11-24: tarea 3 implementada en `feat/clinicas-pacientes`. Entran
  `POST /clinics` y `POST /patients` con sus casos de uso (`CreateClinic`,
  `CreatePatient`), los tipos `Clinic` y `Patient`, `isId`, `E164` e
  `isValidTimeZone`, los puertos `Transactions`, `ClinicRepository`,
  `PatientRepository` e `IdGenerator`, `MikroOrmTransactions` con sus dos
  repositorios, el generador UUIDv7 (dependencia nueva `uuid@14`), los
  controladores, DTOs y presentadores, `test/support/fixtures.ts` y
  `test/clinics-patients.e2e-spec.ts`. `test/architecture.spec.ts` prohíbe
  ahora también `@nestjs` en `src/application`. Cambios respecto al plan:
  - `isValidTimeZone` va en `time-zones.ts`, como dice el mapa de
    `AGENTS.md`, y no en `clinic.ts`; `errors.ts` ya existía;
  - `newId()` no está en `src/domain`: los ids salen del puerto
    `IdGenerator` (sección 2), así que las tareas 5 a 8 lo inyectan en sus
    casos de uso en lugar de importar una función;
  - `isValidTimeZone` rechaza además los offsets fijos, y `isId` acepta
    cualquier UUID canónico, sin mirar la versión;
  - tests añadidos al brief: `local`, `system` y offsets, `phone` a `null`,
    otros 400 de esquema, 400 antes que 404, ida y vuelta del repositorio de
    pacientes y 503 con la base cortada por el proxy TCP.

  La revisión final de la rama no encontró nada grave. Se arregló en la misma
  rama:
  - con la base caída, `POST /clinics` daba 500 y ahora da 503
    (`isDatabaseUnavailable` en `MikroOrmTransactions.run`);
  - `AGENTS.md` declara a `MikroOrmTransactions` como la única excepción a
    «nada hace `new` de un repositorio».

  Queda para otro cambio:
  - un offset con el signo menos de Unicode (`−05:00`) pasa como zona válida;
  - un carácter NUL en `name` da 500 (Postgres lo rechaza con 08P01); haría
    falta un validador de texto compartido en `src/http/validation.ts`;
  - el JSDoc de `IdGenerator` promete orden creciente sin aclarar que es
    dentro de un proceso; con varias réplicas no se cumple (tarea 6 y nota
    de producción);
  - que `findById` de los repositorios devuelva `null` si el id no es UUID,
    como defensa añadida del 404 cuando las tareas 5 y 6 añadan más búsquedas.

  Cada test nuevo se vio fallar por su motivo, con la función ausente o con
  una mutación temporal (aceptar o rechazar todo, la validación de zonas que
  usa `localDateTime`, un generador UUIDv4, quitar `isId`, la búsqueda de la
  clínica, la comprobación de zona o el `@Matches`, y convertir cualquier
  error en 503). La excepción es «JSON mal formado → 400» en `POST /clinics`,
  que pasa desde el principio porque el parser y el filtro globales vienen de
  la tarea 1.

  Verificación: `npm run verify` en verde (12 archivos y 81 unitarios,
  4 archivos y 33 e2e), `npm run build` y
  `docker compose -p clinicsay up --build -d --wait` con un recorrido a mano
  de las dos rutas. Siguiente paso: revisar y mergear la PR; la tarea 5
  consume `Transactions`, `IdGenerator`, `isId` y los fixtures.
- 2026-11-24: tarea 5 implementada en `feat/citas`. Entran
  `POST /appointments` y `GET /appointments/{id}` con sus casos de uso
  (`CreateAppointment`, `GetAppointment`) y `AppointmentView`, los tipos
  `Appointment` y `Reminder` con `newReminder`, los puertos
  `AppointmentRepository` y `ReminderRepository` con sus repositorios de
  MikroORM, `presentAppointment`, `CreateAppointmentDto`,
  `parseIsoDateTimeWithZone`, el fixture `createAppointment` y
  `test/appointments.e2e-spec.ts`. Sin migraciones ni dependencias nuevas.
  Cambios respecto al plan:
  - los ids salen del puerto `IdGenerator`, que `CreateAppointment` recibe
    junto a `Transactions` y `Clock`; `newId()` no existe;
  - `AppointmentRepository.lockById`/`update` y `ReminderRepository.update`
    no entran, porque ningún test de esta tarea los usa. La tarea 6 los
    añade con sus tests y tiene que tocar también `appointment.repository.ts`,
    que su lista de archivos no incluye;
  - `src/domain/appointment.ts` solo tiene tipos y no hay
    `appointment.spec.ts`: las transiciones de cita llegan con la tarea 6;
  - `startsAt` se convierte con `parseIsoDateTimeWithZone` y el validador
    exige la forma `date-time` del contrato (sección 2, «Fechas de entrada»);
  - `virtual: null` cuenta como ausente (`false`), igual que `phone`;
  - tests añadidos al brief: hora de envío ya pasada con el reloj,
    `virtual: false`, `startsAt` igual a la hora del servicio, otros 400 de
    esquema, ids que no son UUID en el cuerpo, 400 antes que 404, 404 antes
    que 400, `startsAt` sin fecha con el reloj en el pasado y el repositorio
    de recordatorios (orden por id e ida y vuelta de todos los campos).

  La revisión final de la rama encontró un problema importante, arreglado en
  la misma rama: `isIsoDateTimeWithZone` (de la tarea 1) aceptaba cualquier
  forma ISO 8601 de Luxon. Con `startsAt: "10:00:00Z"` creaba la cita con la
  fecha del sistema y no con la del reloj, un mes sin día caía en el día 1,
  `+99:00` se aceptaba y un año de 5 cifras daba 500. Ahora es 400. Queda
  para otro cambio:
  - `CreateAppointment` comprueba `isId` dentro de la transacción y
    `CreatePatient` y `GetAppointment` antes; con la base caída, `clinicId`
    `x` da 503 en vez de 404;
  - `GET /appointments/{id}` lee la cita y sus recordatorios en dos
    sentencias con READ COMMITTED: un `PATCH` concurrente (tarea 6) podría
    mostrar una vez un estado mezclado;
  - `POST /appointments` no es idempotente (el contrato no tiene clave);
  - `z` minúscula y offsets sin dos puntos (`+0200`) dan 400.

  Cada test nuevo se vio fallar por su motivo. Los e2e fallaron uno a uno
  por su aserción antes de existir la ruta, y además con una mutación
  temporal cada uno: quitar `isId` (500), `toISOString()` en el presentador,
  `virtual` siempre presente, la zona de la clínica en vez de la efectiva,
  la hora del sistema en vez de `Clock`, `<` en vez de `<=`, quitar la
  comprobación de clínica del paciente, la regla de `startsAt` antes de las
  búsquedas, quitar cada decorador del DTO, quitar el `orderBy` o el
  `nextAttemptAt` del repositorio, el GET sin recordatorios, quitar cada 404
  e ignorar `too_late`. Los unitarios de `newReminder` y de
  `parseIsoDateTimeWithZone`, con mutaciones de una línea. Los dos tests que
  pasaban desde el principio («acepta una fecha con milisegundos / sin
  segundos») fijan lo que la regex no debe endurecer; caen al hacer
  obligatorios los segundos o al quitar la fracción.

  Verificación: `npm run verify` en verde (13 archivos y 99 unitarios,
  5 archivos y 60 e2e) y `docker compose -p clinicsay up --build -d --wait`
  con un recorrido a mano: `POST` 201, `GET` 200 con la misma cita,
  `virtual: true` solo en la virtual, `GET /appointments/abc` 404,
  `clinicId` `x` 404, `startsAt` `10:00:00Z` 400 y `startsAt` pasada 400.
  `scripts/smoke.sh` llega con la tarea 9. Siguiente paso: revisar y mergear
  la PR; la tarea 6 consume `Appointment`, `Reminder`, `newReminder`, los dos
  repositorios, `AppointmentView`, `presentAppointment` y
  `parseIsoDateTimeWithZone`.
- 2026-11-24: tarea 6 implementada en `feat/reprogramar-cancelar`. Entran
  `PATCH /appointments/{id}` y `POST /appointments/{id}/cancel` con sus
  casos de uso (`RescheduleAppointment`, `CancelAppointment`),
  `RescheduleAppointmentDto`, las transiciones `hasStarted`,
  `rescheduleAppointment`, `cancelAppointment`, `confirmAppointment` y
  `cancelReminder`, `AppointmentRepository.lockById`/`update`,
  `ReminderRepository.lockPendingByAppointment`/`update` y
  `test/reschedule-cancel.e2e-spec.ts`. Sin migraciones ni dependencias
  nuevas. Cambios respecto al plan:
  - se modifica también `appointment.repository.ts` (`lockById` y `update`
    no entraron en la tarea 5);
  - `RescheduleAppointment` recibe `Transactions`, `IdGenerator` y `Clock`;
    los ids salen del puerto, no de `newId()`;
  - los dos casos de uso comprueban `isId` antes de abrir la transacción, y
    `PATCH` mira cancelada o empezada (409) y `startsAt` (400) antes de
    bloquear los pendientes, no después: no dependen de ellos y así un
    error no espera al job;
  - las lecturas de los repositorios de citas y recordatorios no usan el
    identity map (sección 2): dentro de una transacción, una lectura tras un
    `update` devolvía la fila vieja (reproducido en dos tests);
  - cancelar una cita que ya empezó responde 200 y la cancela, y
    `confirmAppointment` entra ya aunque solo lo use la tarea 8;
  - tests añadidos al brief: los bloqueos con dos transacciones reales,
    lecturas tras `update` en la misma transacción, tres `PATCH` a la vez,
    cancelar con un `PATCH` esperando al job, cita virtual, `too_late` al
    reprogramar, 409 antes que 400, 400 antes que 404 y los 400 de esquema.

  La revisión final de la rama no encontró nada crítico. Se arregló en la
  misma rama: faltaba un test que fallara si cancelar no bloquea la cita
  (con la mutación se perdía la hora nueva del `PATCH` y quedaba un
  pendiente en la cita cancelada), la regla de bloqueo no aclaraba que el
  job no puede esperar la cita con un recordatorio bloqueado (deadlock
  `40P01`), y unos `as` de los tests no tenían el comentario de límite.
  Queda para otro cambio:
  - el test de Review Focus 3 no distingue el orden por id del orden por
    `scheduledFor`, porque las horas crecen (lo detectan otros tres tests);
  - el JSDoc de `update` en los puertos no dice que hay que llamarlo con la
    fila bloqueada;
  - un `PATCH` con el mismo `startsAt` desconfirma la cita y crea otro
    recordatorio (lectura literal de la regla 8); falta decidirlo;
  - `holdLock` podría tipar `repos` como `Repositories`, y
    `disableIdentityMap` podría ir en `createOrmConfig` en vez de en cada
    repositorio.

  Cada test nuevo se vio fallar por su motivo: los unitarios con la función
  ausente y con una mutación de una línea cada uno; los de repositorio con
  el método ausente, con datos viejos del identity map y con 7 mutaciones
  (sin `FOR UPDATE`, con `SKIP LOCKED`, sin filtrar `pending`, columnas
  fuera del `update`); los de `PATCH` y cancelar con la ruta ausente y con
  20 mutaciones (sin bloqueo, sin cancelar el pendiente, sin cada 409, 400
  antes que 409, `<` en vez de `<=`, zona de la clínica en vez de la
  efectiva, hora del sistema, sin `isId`, sin `@HttpCode(200)`, sin el
  validador del DTO, entre otras). Sin `lockById`, tres `PATCH` a la vez
  daban `[200, 200, 500]` por `reminder_one_pending` (4 de 4 veces), y
  cancelar sin bloqueo perdía la hora nueva (3 de 3). La excepción es «ya
  cancelada → sin escribir», que no se distingue desde fuera de reescribir
  lo mismo: solo se prueba que la respuesta repetida es igual.

  Verificación: `npm run verify` en verde (14 archivos y 116 unitarios,
  6 archivos y 97 e2e) y `docker compose -p clinicsay up --build -d --wait`
  con un recorrido a mano: `PATCH` 200 dos veces con
  `[cancelled, cancelled, pending]`, 400 sin zona y con fecha pasada, 404
  con `abc`, cancelar 200 dos veces con el mismo cuerpo, `PATCH` de la
  cancelada 409 y `GET` igual que la última respuesta. `scripts/smoke.sh`
  llega con la tarea 9. Siguiente paso: revisar y mergear la PR; la tarea 7
  añade «reprogramar después de enviado» y usa `ReminderRepository.update`;
  la tarea 8 usa `confirmAppointment`, `cancelAppointment`, `cancelReminder`
  y el orden cita → pendientes.
- 2026-11-24: tarea 7 implementada en `feat/job-envio`. Entran
  `POST /jobs/reminders/run` con `RunReminderPass` y `JobsController`, el
  puerto `MessageProvider` con `HttpMessageProvider`, `ShutdownCoordinator`,
  `retry-policy.ts` (`RETRY_DELAYS_MINUTES`, `MAX_ATTEMPTS`, `nextRetryAt`),
  `provider-outcome.ts` (`ProviderResult`, `classifyProviderResult`),
  `skipReasonAtSendTime`, `skipReminder` y `recordAttempt` en `reminder.ts`,
  `ReminderRepository.lockNextDue`/`nextSendSequence`,
  `test/reminder-job.e2e-spec.ts` y el caso «reprogramar después de
  enviado». Sin migraciones ni dependencias nuevas. Cambios respecto al plan:
  - el coordinador aborta y espera en `beforeApplicationShutdown`, no en
    `onApplicationShutdown`: antes Nest cierra el servidor HTTP, que espera a
    la petición del job, y una pasada sin abortar vaciaba la cola
    (reproducido con una mutación);
  - `sentAt` y la hora del fallo son `clock.now()` después de la llamada al
    proveedor; `too_late` se mira antes;
  - cualquier 2xx es `sent` (el plan solo nombraba 202 y 200), y 1xx y 3xx
    se reintentan;
  - `skipReminder`, `recordAttempt` y `nextRetryAt` lanzan un `Error` simple
    ante un fallo de programación (no pendiente, `delivered` sin `sendSeq`,
    intentos no positivos);
  - el timeout se prueba con un modo nuevo del proxy TCP,
    `dropResponses(true)`, que deja llegar la petición y descarta la
    respuesta y el cierre de la conexión. Así es determinista y prueba
    además «puede haberse entregado» sin duplicar;
  - `holdLock` pasa a `test/support/locks.ts` y `ProviderAdmin.requests()`
    admite no filtrar por teléfono;
  - tests añadidos al brief: texto en Canarias y en una cita virtual,
    `too_late` en el primer intento, segunda pasada sin reenvío, `sendSeq` y
    `sentTo`, el job con la cita bloqueada por un `PATCH` (sin deadlock), un
    `PATCH` mientras el job espera al proveedor, error de red, timeout y
    cierre con una pasada en curso.

  La revisión final de la rama no encontró nada crítico. Se arregló en la
  misma rama: faltaba un test que fallara si el job bloqueaba la cita (con
  `lockById` daba `40P01`) y otro para `sendSeq` y `sentTo`, y un 201 o 204
  dejaba `failed` un mensaje entregado. Queda para otro cambio o para la
  nota de producción:
  - un error inesperado en un recordatorio corta la pasada y, como ese
    recordatorio va primero, las siguientes también;
  - 408 y 429 quedan `failed` por la regla «cualquier 4xx»; un
    `PROVIDER_URL` con `/` final llama a `//messages`;
  - `excludeIds` crece con cada recordatorio tratado en la pasada (`NOT IN`
    con todos); fijar `now` al empezar la pasada lo evitaría;
  - `skipReasonAtSendTime` repite la regla de `hasStarted`, y el
    `reason ?? 'no_phone'` del caso de uso solo estrecha el tipo;
  - no hay e2e del job con la base caída (503).

  Cada test nuevo se vio fallar por su motivo. Los unitarios, contra un
  esqueleto que exportaba los nombres sin comportamiento; los tres que
  pasaban con él, con una mutación. Los de repositorio, contra métodos que
  devolvían `null` o `0` y con 7 mutaciones (sin filtro de estado, de hora
  o de `excludeIds`, sin bloqueo, sin `SKIP LOCKED`, otro orden). Los del
  job fallaban todos con 404 antes de existir la ruta, y además cada uno con
  su mutación (clave = id de la cita o distinta por intento, sin cabecera,
  sin guardar el resultado, zona fija, zona sin `virtual`, hora prevista en
  vez de la actual, rechazo como reintento, sin mirar teléfono, baja o
  inicio, sin bloqueo, ignorar la señal, sin `try/catch`, sin timeout,
  `lockById`, `sendSeq` fijo, sin abortar o en `onApplicationShutdown`). Sin
  bloqueo en `lockNextDue`, 5 pasadas a la vez duplicaban llamadas (4 de 4
  veces). La espera del coordinador no se ve en e2e (`server.close()` y el
  pool de `pg` ya esperan): la prueban sus unitarios con 7 mutaciones. Que
  el controlador registre la pasada en el coordinador no lo detecta ningún
  test por esa misma razón.

  Verificación: `npm run verify` en verde (17 archivos y 169 unitarios,
  7 archivos y 128 e2e) y `docker compose -p clinicsay up --build -d --wait`
  con un recorrido a mano: nada antes de su hora, 5 pasadas a la vez sobre
  20 recordatorios (3 + 4 + 4 + 5 + 4 tratados; 21 peticiones con 20 claves
  distintas, la de más es el reintento del 503 con la misma clave), envío
  con el texto exacto, 503 y envío al minuto con `attempts` 2, y 422 →
  `failed`. `scripts/smoke.sh` llega
  con la tarea 9. Siguiente paso: revisar y mergear la PR; la tarea 8 usa
  `sendSeq` y `sentTo` para elegir la cita de una respuesta, y la 9 cuenta
  lo pendiente en la nota de producción.
- 2026-11-24: tarea 8 implementada en `feat/webhook`. Entran
  `POST /webhooks/inbound-messages` con `HandleInboundMessage`,
  `WebhooksController` e `InboundMessageDto`, `parseReply`
  (`src/domain/patient-reply.ts`), `canReceiveReply` en `appointment.ts`, el
  puerto `InboundMessageRepository` con `MikroOrmInboundMessageRepository`
  (`insertIfNew`), `AppointmentRepository.lockLatestRepliable` y
  `test/webhook.e2e-spec.ts`. Sin migraciones (la tabla `inbound_message` y
  el índice `reminder_last_sent` vienen de la tarea 2) ni dependencias
  nuevas. Cambios respecto al plan:
  - se tocan también `mikro-orm-transactions.ts` (fábrica de repositorios),
    `app.module.ts` y `src/domain/appointment.ts`;
  - `lockLatestRepliable` es una sola consulta con `FOR UPDATE OF` la cita:
    si la cita cambia mientras espera el bloqueo, Postgres vuelve a evaluar
    la consulta y pasa a la anterior que cumpla (sección 2). La comprobación
    con `canReceiveReply` en el caso de uso se mantiene, pero con esa
    consulta nunca descarta nada;
  - `parseReply` usa una expresión anclada en vez de la del plan, que
    tardaba un tiempo cuadrático (sección 2), y se llama fuera de la
    transacción;
  - el 200 va sin cuerpo;
  - tests añadidos al brief: `insertIfNew` con otra transacción que tiene el
    mismo id, `receivedAt` frente al reloj, `from` que no es E.164 o que
    lleva SQL, un recordatorio aún pendiente no cuenta, orden de envío
    distinto del de creación, `sentAt` hacia atrás, NO después de SI, id
    repetido tras uno ignorado, SI que espera a que cancelen la última cita,
    NO mientras el job envía el pendiente, cuerpo en lista y otros 400 de
    esquema, tilde en la primera letra y texto largo.

  La revisión final de la rama no encontró nada crítico. Se arregló en la
  misma rama la expresión de `parseReply`: «a» + 100 000 espacios + «a»
  tardaba 10,4 s y el body parser admite ese tamaño en una sola petición.
  Queda para otro cambio o para la tarea 9:
  - un NUL en `messageId` o en `from`, o un `messageId` de unos 2,7 kB, da
    500 y el proveedor reenviaría el mensaje sin fin (va con el validador de
    texto compartido pendiente);
  - el bloque «cancelar la cita y sus pendientes» se repite en
    `HandleInboundMessage` y `CancelAppointment`;
  - los e2e de concurrencia esperan 200 ms; en un CI lento podrían pasar
    sin llegar al bloqueo (no dan falsos rojos);
  - un mensaje ignorado no deja traza (id y motivo, sin texto ni teléfono);
  - para el README y la nota de producción: dos NO seguidos desde un
    teléfono compartido cancelan dos citas; un NO durante un `lost-response`
    va a la cita anterior; `from` se compara tal cual, sin normalizar; y
    `inbound_message` crece sin purga.

  Cada test nuevo se vio fallar por su motivo. Los unitarios de
  `parseReply`, contra un esqueleto que devolvía siempre `null` o siempre
  `yes` y con 4 mutaciones de una línea; los de `canReceiveReply`, contra
  esqueletos que devolvían siempre `true` o `false`. Los e2e fallaban todos
  antes de existir el código (los de repositorio por el método ausente y
  los de HTTP con 404), y además cada uno con su mutación, 31 en total: sin
  `@HttpCode(200)`, sin el DTO o sin cada decorador, `from` como E.164, sin
  mirar `insertIfNew` o registrando solo lo aplicado, `receivedAt` como hora
  de negocio, SI que cancela, NO sin cancelar la cita o el pendiente,
  pendientes sin bloqueo, sin `FOR UPDATE OF`, `send_seq asc`, orden por
  `sent_at`, por id del recordatorio o de la cita, sin filtrar canceladas o
  empezadas, `>=` en vez de `>`, teléfono del paciente en vez de `sent_to`,
  sin filtrar por teléfono, teléfono concatenado en el SQL, sin `on
  conflict` y otra `receivedAt` al guardar. La única que sobrevive es
  quitar `canReceiveReply` del caso de uso, por lo dicho arriba. El cuerpo
  en lista ya daba 400 antes de la tarea: solo cae sin el DTO.

  Verificación: `npm run verify` en verde (18 archivos y 198 unitarios,
  8 archivos y 161 e2e) y `docker compose -p clinicsay up --build -d --wait`
  con un recorrido a mano: «Sí, gracias» ignorado, SI a la última enviada
  de un teléfono compartido, el mismo `messageId` tras reprogramar sin
  efecto, NO que cancela la cita y su pendiente, otro NO que cae en la
  anterior, 400 `{ error }` sin `messageId` o con `receivedAt` sin zona,
  `from` no E.164 con 200, el 200 sin cuerpo y un texto de 100 000
  caracteres en 6 ms. `scripts/smoke.sh` llega con la tarea 9. Siguiente paso: revisar y mergear la PR; la tarea 9 escribe
  el README y la nota de producción con lo pendiente de arriba.
- 2026-11-24: arreglado en `fix/validar-entradas` el hallazgo I2 de la
  revisión de `main` previa a la tarea 9: había cuerpos que pasaban el DTO y
  Postgres rechazaba, y la API respondía 500 donde tocaba 400. En el webhook
  era peor, porque el proveedor reenviaría el mensaje sin fin. Reproducido
  antes de arreglar, con un spec temporal contra la app real:
  - NUL en `name` de clínicas y pacientes y en `messageId` o `from` del
    webhook (con texto SI): 500 por `08P01`. Un NUL en `text` daba 200 y
    sigue así;
  - `messageId` de unos 2700 caracteres aleatorios: 500 por `54000`
    (`index row size 2712 exceeds btree version 4 maximum 2704`). Con 10 000
    `x` daba 200, porque Postgres comprime la clave;
  - año 0 (`22008`) y fechas que en UTC pasan al año 10000 (`22009`) en
    `startsAt` y `receivedAt`: 500. En `PUT /test/clock` respondía 204, pero
    después el job y el webhook daban 500.

  Entran `@IsStorableText` y `MAX_TEXT_LENGTH` y el rango de años en
  `isIsoDateTimeWithZone`, con su propio mensaje (sección 2, «Rango de
  fechas de entrada» y «Textos de entrada»). Sin migraciones ni dependencias
  nuevas. `test-clock.controller.ts` no se toca: su DTO ya usa el validador,
  y `new Date()` da el mismo instante que Luxon en todas las formas que
  acepta.

  Cada test nuevo se vio fallar por su motivo antes del arreglo: los
  unitarios del rango de años, con `true` donde se esperaba `false`; los de
  `IsStorableText`, contra un esqueleto que solo aplicaba `@IsString()`; y
  los 16 e2e, con 500 (NUL, clave btree, años), 201 o 200 (longitud de más),
  204 (reloj) o 404 (`startsAt` en el año 0, que antes se validaba como
  regla de negocio, después de buscar la clínica). Los tres de borde que
  pasaban desde el principio (un `name` de 200, un `messageId` de 255
  caracteres de 7 bytes que se deduplica y un `text` con NUL que se ignora)
  caen con una mutación cada uno: límite de 199, límite de 254 y
  `@IsStorableText` en `text`.

  Queda para otro cambio: con el reloj de test en los últimos minutos del
  año 9999, un reintento cae en el año 10000 y el job da 500 (reproducido
  con `9999-12-31T23:58:00Z` y dos 503). No es una entrada, sino una fecha
  calculada, y con el reloj del sistema no se da.
- 2026-11-24: arreglado en `fix/aislar-recordatorio` el hallazgo I1 de la
  revisión de `main` previa a la tarea 9, junto con el menor M1 y un e2e que
  fallaba a veces.
  - I1: un error inesperado dentro de la transacción de un recordatorio
    cortaba la pasada con un 500. Como ese recordatorio seguía pendiente con
    el `next_attempt_at` más antiguo, bloqueaba la cola en todas las pasadas
    siguientes. Reproducido con dos clínicas con una cita cada una y la
    primera con `timezone = 'Nope/Zone'` escrita por SQL: `buildReminderText`
    lanzaba `invalid time zone`, el job daba 500 y la segunda cita no salía
    de `pending`. Ahora `RunReminderPass` registra el error con el id, no lo
    cuenta en `processed`, lo aparta de la pasada y sigue; queda `pending` y
    no `failed` (sección 2, «Job de envío»). Siguen cortando la pasada la
    base caída (503) y un error antes de tomar ningún recordatorio;
  - entran el puerto `Logger` y `NestLogger`, porque `src/application` no
    puede importar el de Nest. Cada `useFactory` crea el suyo con el nombre
    del caso de uso como contexto. El id se apunta en los excluidos en cuanto
    se bloquea el recordatorio, en vez de viajar en el error, para no
    ocultarle a `isDatabaseUnavailable` una caída de la base;
  - M1: un e2e llama a `beforeApplicationShutdown` del coordinador sin cerrar
    la app, con la pasada esperando al proveedor, y comprueba que al volver
    el intento ya está guardado. Otro cuenta los listeners de SIGTERM antes y
    después de `createApp`. Ahora se detecta que el controlador deje de usar
    `track` (la entrada de la tarea 7 lo daba por no cubierto) o que falte
    `enableShutdownHooks()`;
  - «un error de red se reintenta al minuto» apuntaba a un puerto recién
    liberado, que otro proceso llegó a ocupar y contestar con un 4xx (el
    recordatorio quedaba `failed`). Ahora apunta a `startResetServer`
    (`test/support/reset-server.ts`), que corta cada conexión con un RST al
    aceptarla, y `fetch` falla con `ECONNRESET`;
  - sin migraciones ni dependencias nuevas.

  Cada test nuevo se vio fallar por su motivo. El de I1, contra la pasada de
  `main`: 500 en vez de 200. Los otros cuatro protegen comportamiento que ya
  existía y caen con una mutación cada uno: sin la excepción de
  `ServiceUnavailableError`, el proveedor recibe 2 peticiones en vez de 1;
  sin cortar cuando no se tomó nada, la pasada sigue tras 2 s; sin `track`,
  `attempts` 0 en vez de 1; y sin `enableShutdownHooks()`, ningún listener
  de SIGTERM de más. Quitar el registro del error hace fallar el de I1 (0
  llamadas), y el unitario de `NestLogger` cae con un esqueleto vacío y sin
  el contexto. El del error de red pasa 3 de 3 veces y cae si ese error se
  trata como un 422.

  Queda para otro cambio o para la nota de producción: un recordatorio que
  falla siempre se reintenta en cada pasada, sin límite, y si el error llega
  después de la llamada el proveedor recibe una petición por pasada (con la
  misma clave, así que el paciente no recibe dos mensajes). Haría falta
  contar los errores o apartarlo para revisión. Por el mismo camino, el
  reintento que cae en el año 10000 (entrada anterior) debería pasar de
  500 a quedar registrado sin frenar a los demás; no se ha reproducido.

  Verificación: `npm run verify` en verde tras el merge de `main`
  (19 archivos y 212 unitarios, 8 archivos y 185 e2e) y
  `docker compose -p clinicsay up --build -d --wait` con el escenario a
  mano: dos pasadas con 200 `{ processed: 1 }` y `{ processed: 0 }`, la cita
  de la clínica rota `pending` con `attempts` 0, la otra `sent` y en el log
  de la api el id del recordatorio junto a `invalid time zone: Nope/Zone`.
  `scripts/smoke.sh` llega con la tarea 9. Siguiente paso: revisar y mergear
  la PR.
- 2026-11-24: tarea 9 (entrega) en `docs/entrega`, PR
  [#13](https://github.com/aarondevl/clinicsay-backend-challenge/pull/13).
  Entran `scripts/smoke.sh` y su paso en el job `compose` del CI (tras el
  `/health`), el README de entrega con los cinco apartados del enunciado, la
  skill `.claude/skills/verificar` y la versión final de `AGENTS.md` (humo y
  skill en el mapa y los comandos, los dos jobs del CI, la frase de las skills
  de la plantilla) y `CLAUDE.md`. Sin cambios en `src/`, sin migraciones ni
  dependencias nuevas. Cambios respecto al plan:
  - `smoke.sh` es bash y no sh: `dash` no admite `pipefail` y `node:24-alpine`
    no trae bash ni curl. Usa solo bash, curl, grep y sed, todos en
    `ubuntu-latest`. Comprueba además la hora de envío, la `Idempotency-Key`
    = id del recordatorio y el recordatorio `sent`;
  - para poder repetirlo sobre la misma base vacía el proveedor, usa un
    teléfono al azar y lanza una pasada previa a la hora de envío; sin ella,
    un pendiente que dejó otra prueba daba `{"processed":2}` (reproducido). El
    `+` del teléfono va como `%2B` en la query del proveedor, que la lee con
    `URLSearchParams`;
  - el compose se levanta con el proyecto `clinicsay` (`-p` o
    `COMPOSE_PROJECT_NAME`), y `AGENTS.md` y la skill explican por qué en un
    worktree y que se verifica uno a la vez;
  - el README deja fuera el enlace al formulario y el plazo de la plantilla
    de partida, y conserva «Reglas de código» y el enlace al enunciado;
  - el mapa de `AGENTS.md` gana dos filas: arranque y humo, y la skill;
  - la PR no se mergea: queda para revisión.

  El humo pasa contra `main` desde el principio, así que se vio fallar con
  tres mutaciones de la app, cada una con su `--build` (texto sin el punto
  final, `processed += 2` e `Idempotency-Key` = id de la cita), y con el
  script sin la pasada previa: `exit=1` y su mensaje las cuatro veces.

  La revisión final de la rama no encontró nada crítico. Se arregló en la
  misma rama: el README decía que un reintento que cae en el año 10000 da
  500, pero desde #12 la pasada lo registra y sigue (reproducido: 200
  `{"processed":0}`, `pending` con `attempts` 0, un 503 por pasada y
  `22009` en el log); «lo que se corrigió de la IA» atribuía a la IA dos
  bloqueos que el plan ya pedía, y ahora cuenta los tests y la regla que
  faltaban; y precisiones de texto en el README, `AGENTS.md` y la skill.

  Flujo con el que se hizo todo (README, apartado 5): una sesión
  coordinadora reparte cada tarea a una sesión trabajadora con su worktree y
  su PR; cada PR se revisa contra el plan, `AGENTS.md` y el Review Focus; la
  revisión de todo `main` previa a esta tarea, hecha con otro modelo, dio
  lugar a #11 y #12. PR de la entrega:
  [#1](https://github.com/aarondevl/clinicsay-backend-challenge/pull/1)
  andamiaje,
  [#2](https://github.com/aarondevl/clinicsay-backend-challenge/pull/2)
  reglas de código,
  [#3](https://github.com/aarondevl/clinicsay-backend-challenge/pull/3) hora
  de envío y texto,
  [#4](https://github.com/aarondevl/clinicsay-backend-challenge/pull/4) el
  dominio no lanza errores de `application`,
  [#5](https://github.com/aarondevl/clinicsay-backend-challenge/pull/5)
  persistencia,
  [#6](https://github.com/aarondevl/clinicsay-backend-challenge/pull/6)
  clínicas y pacientes,
  [#7](https://github.com/aarondevl/clinicsay-backend-challenge/pull/7)
  citas,
  [#8](https://github.com/aarondevl/clinicsay-backend-challenge/pull/8)
  reprogramar y cancelar,
  [#9](https://github.com/aarondevl/clinicsay-backend-challenge/pull/9) job
  de envío,
  [#10](https://github.com/aarondevl/clinicsay-backend-challenge/pull/10)
  webhook,
  [#11](https://github.com/aarondevl/clinicsay-backend-challenge/pull/11)
  validar entradas,
  [#12](https://github.com/aarondevl/clinicsay-backend-challenge/pull/12)
  aislar un recordatorio con error y
  [#13](https://github.com/aarondevl/clinicsay-backend-challenge/pull/13)
  entrega.

  Queda fuera lo que lista el README en su apartado 3 (comportamientos
  conocidos, tests y producto), que recoge lo pendiente de estas entradas y
  de la revisión de `main`.

  Verificación: desde una base vacía, `docker compose -p clinicsay up
  --build -d --wait` con los tres servicios sanos, `npm run verify` en verde
  (19 archivos y 212 unitarios, 8 archivos y 185 e2e) y
  `./scripts/smoke.sh` con `exit=0`; después `docker compose -p clinicsay
  down -v`. Siguiente paso: revisar y mergear la PR #13 con `checks` y
  `compose` en verde antes del cierre (25-11-2026, 17:30 de Madrid). No
  queda otra tarea del plan.
- 2026-11-24: arreglado en `fix/franja-al-enviar`, PR
  [#14](https://github.com/aarondevl/clinicsay-backend-challenge/pull/14),
  el hallazgo importante de la revisión final de `main`: la franja de
  silencio solo se aplicaba al planificar (`planReminder`) y no al enviar.
  - escenario: una cita del 11/03/2027 a las 10:00 de Madrid creada a las
    20:59:30 del día antes tiene `scheduledFor` a esa hora; la pasada de las
    21:00 la enviaba. Igual con un cron atrasado o una cola acumulada que se
    toma a las 23:00. `RunReminderPass` solo miraba `too_late`, `no_phone` y
    `opted_out` antes de llamar, y la regla 3 dice que en la franja no se
    envía nada salvo los reintentos;
  - arreglo (sección 2, «Job de envío»): `quietHoursEnd` en
    `reminder-schedule.ts` reutiliza la lógica de `planReminder`
    (`outOfQuietHours` pasa a `endOfQuietHours` y devuelve `null` fuera de
    la franja), y `holdForQuietHours` y `postponeReminder` en `reminder.ts`
    deciden el aplazamiento. La pasada lo aplica tras los descartes y antes
    de llamar, con la zona efectiva; un aplazado no cuenta en `processed` y
    el `too_late` sí;
  - en la misma rama y solo de texto: los hallazgos menores de la revisión
    final en el apartado 3 del README (la línea del pool se amplía en vez de
    repetirse) y «Difiere del enunciado» en lugar de «Choca» en la tabla de
    indicaciones del expositor. El README usa «chocaba» solo para el
    puerto, en otro sentido, y no cambia;
  - sin migraciones ni dependencias nuevas.

  Cada test nuevo se vio fallar por su motivo. Contra la pasada de `main`,
  cuatro e2e en rojo: 21:00, 23:00 y la cita virtual de Canarias daban
  `{ processed: 1 }` en vez de 0, y la de las 09:00 quedaba `sent` con
  `attempts` 1 en vez de `skipped`/`too_late`. Los 18 unitarios nuevos
  fallaban porque las funciones no existían. Los que protegen lo que ya
  funcionaba caen con una mutación cada uno: sin la condición de
  `attempts > 0`, el e2e y el unitario del reintento dentro de la franja;
  con la zona de la clínica en vez de la efectiva, el e2e de la cita
  virtual; y sin `assertPending` en `postponeReminder`, su unitario.

  Verificación: `npm run verify` en verde (19 archivos y 231 unitarios, 8
  archivos y 190 e2e), `docker compose -p clinicsay up --build -d --wait` con
  los tres servicios sanos y `./scripts/smoke.sh` con `exit=0`. Con el
  compose, el escenario a mano: `{"processed":0}` a las 21:00, sin
  peticiones al proveedor y `pending` con `attempts` 0; a las 09:00,
  `{"processed":1}`, `sent` con `sentAt` 2027-03-11T08:00:00Z y
  `scheduledFor` sin cambiar. Siguiente paso: revisar y mergear la PR #14.
- 2026-11-24: arreglado en `fix/4xx-sin-cuerpo`, PR
  [#15](https://github.com/aarondevl/clinicsay-backend-challenge/pull/15),
  otro hallazgo importante de la revisión final de `main`: un 4xx del
  proveedor se podía reintentar.
  - escenario: el proveedor responde 422 (en `provider/server.mjs`,
    «rejected by the carrier (do not retry)») y corta la conexión antes de
    terminar el cuerpo, o el cuerpo no
    llega antes de `AbortSignal.timeout`. `HttpMessageProvider.send()` leía
    el cuerpo en el mismo `try` que `fetch`, así que el `catch` devolvía
    `network_error` o `timeout` aunque ya se supiera el código. El
    recordatorio quedaba `pending` y a T+1 min salía otra petición, que
    podía entregar un mensaje que el operador había rechazado. Con un 202
    pasaba lo mismo: un intento de más;
  - arreglo (sección 2, «Job de envío»): en cuanto `fetch` resuelve, el
    resultado es `{ kind: 'response', status }`. El cuerpo se sigue leyendo
    para liberar la conexión, en `discardBody`, y si falla solo se registra
    con la clave de idempotencia. `timeout` y `network_error` quedan para
    cuando no llegaron las cabeceras. `classifyProviderResult` no cambia;
  - tests: `test/support/truncated-body-server.ts` responde el código con
    las cabeceras y un `content-length` mayor que lo que envía, y después
    corta la conexión (`cut`) o la deja abierta hasta el timeout (`stall`).
    El proveedor falso no puede hacerlo porque siempre envía el cuerpo
    completo. Contra él, un unitario del adaptador
    (`http-message-provider.spec.ts`, con un caso más que comprueba que sin
    cabeceras sigue siendo `network_error`) y un e2e del job: 422 →
    `failed` y 202 → `sent`, los dos con `attempts` 1 y sin otra petición a
    T+1 min ni a T+6 min. `AGENTS.md` cuenta en «Tests» esta forma de
    provocar el fallo;
  - sin migraciones ni dependencias nuevas; el README no cambia, porque ya
    decía que se reintentan el error de red y el timeout.

  Cada test nuevo se vio fallar por su motivo. El unitario, contra el
  adaptador de `main`: `network_error` en vez de `response` 422 o 202 con
  el cuerpo cortado, y `timeout` con el cuerpo que no llega (4 en rojo, el
  de sin cabeceras en verde). El e2e, con ese mismo adaptador: `pending` en
  vez de `failed`, y `pending` con `sentAt` nulo en vez de `sent` (4 en
  rojo). Quitar el registro del fallo al leer el cuerpo hace caer los 4
  unitarios.

  Verificación tras mergear `main` con #14: `npm run verify` en verde (20
  archivos y 236 unitarios, 8 archivos y 194 e2e), `docker compose -p
  clinicsay up --build -d --wait` con los tres servicios sanos y
  `./scripts/smoke.sh` con `exit=0`; después `docker compose -p clinicsay
  down -v`. Siguiente paso: revisar y mergear la PR.
- 2026-11-24: añadido en `test/contrato-openapi`, PR
  [#16](https://github.com/aarondevl/clinicsay-backend-challenge/pull/16), un
  test de contrato. Hasta ahora ningún test leía `openapi.yaml`: los e2e
  copiaban sus valores a mano, y los tests de evaluación miden contra ese
  archivo.
  - `test/support/contract.ts` (`expectContract`, `uncoveredResponses`) carga
    `openapi.yaml` con `yaml` y valida con Ajv 2020 y `ajv-formats` en modo
    estricto (sección 2, «Test de contrato»). `test/support/contract.spec.ts`
    fija ese modo sin base (36 unitarios);
  - `test/contract.e2e-spec.ts` (50 e2e) ejercita las diez operaciones y sus
    21 respuestas documentadas, con citas en cada estado de cita y de
    recordatorio, una cita virtual y fechas con milisegundos. El último test
    falla si alguna respuesta documentada no se ejercitó;
  - no encontró ninguna desviación del contrato, así que `src/` no cambia.
    Sin migraciones; dependencias de desarrollo nuevas: `ajv`, `ajv-formats`
    y `yaml`;
  - `AGENTS.md`: fila del mapa, invariante «Contrato», uso del helper en
    «Tests», recetas, «Cómo hacer un cambio» y la trampa de importar Ajv
    desde ESM. README: cómo se comprueba el contrato.

  Cada test se vio fallar por su motivo. Los unitarios, primero sin el
  módulo; después, una mutación por regla del helper (sin
  `additionalProperties: false`, sin el patrón de fechas, sin la extensión
  `virtual` o con `virtual` booleano, sin la regla de los 4xx, sin comprobar
  el cuerpo vacío, el código documentado o la cobertura) tumba solo sus
  tests. El e2e, con mutaciones temporales de `src/`: un `sendSeq` de más en
  el presentador (21 en rojo), fechas con `.000` (21), `virtual: false` en la
  respuesta (19), errores con `statusCode` (29), el webhook sin
  `@HttpCode(200)`, que responde un 201 no documentado (3), un cuerpo en el
  200 del webhook (3) y el bloque de `PATCH` saltado (la cobertura lista
  `PATCH /appointments/{id}` 400, 404 y 409).

  Verificación: `npm run verify` en verde (21 archivos y 272 unitarios, 9
  archivos y 244 e2e), `docker compose -p clinicsay up --build -d --wait`
  con api y db sanas y el proveedor arriba, y `./scripts/smoke.sh` con
  `exit=0`; después `docker compose -p clinicsay down -v`. Siguiente paso:
  revisar y mergear la PR.
- 2026-11-24: en la misma PR #16, `docs/api.html`, una página estática que
  muestra `openapi.yaml` con Redoc. Lee `../openapi.yaml` al abrirse, así que
  no hay copia del contrato que se desincronice. Redoc 2.5.4 viene de jsDelivr
  con la versión exacta y su hash SRI (el archivo del CDN es idéntico al del
  paquete de npm); no se usa la 3.2.0 porque tiene menos de dos semanas y la
  rama 3 es un major de octubre. Abierta con `file://`, donde `fetch` no lee
  el contrato, explica cómo servirla; si Redoc o el contrato no cargan, lo
  dice. README (apartado 1) y `AGENTS.md` (mapa y comandos) cuentan cómo
  verla con `python3 -m http.server 8000 --bind 127.0.0.1`. Sin
  dependencias, sin endpoints y sin cambios en `src/`.

  Verificación: con ese servidor, Chrome sin interfaz (`--dump-dom` y
  `--screenshot`) muestra las diez operaciones, el título y la descripción
  del contrato, y el servidor registra la petición a `/openapi.yaml`. Con
  `file://` aparece el aviso con el comando; con jsDelivr bloqueado
  (`--host-resolver-rules`) o con el hash alterado en una copia temporal, el
  aviso de que Redoc no cargó; con una copia temporal en una carpeta sin
  `../openapi.yaml`, el 404 del contrato.
