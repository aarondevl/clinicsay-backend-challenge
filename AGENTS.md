# AGENTS.md

Guía para cualquier agente de IA (o persona) que cambie este repositorio.
Servicio de recordatorios de citas: API REST en NestJS 12 (ESM), TypeScript,
MikroORM 7 y Postgres 17. Un job envía un recordatorio por paciente a través de
un proveedor de mensajes y un webhook recibe las respuestas SI/NO.

## Fuentes de verdad

1. `enunciado.pdf`: reglas de negocio y entregables.
2. `openapi.yaml`: el contrato de la API; los tests de evaluación lo usan.
3. `provider/server.mjs`: el proveedor falso con el que se evalúa. No se
   modifica, igual que el bloque `provider` de `docker-compose.yml`.
4. Las secciones 1 y 2 de `docs/2026-11-23-recordatorios-design.md`:
   ambigüedades resueltas y decisiones con su porqué. La sección 3 es el plan
   con el que se construyó; es historia, no especificación.
5. Los tests. Si un test y este archivo discrepan, se señala la diferencia y se
   resuelve en un cambio aparte, no de paso.

## Cómo hacer un cambio

1. Leer la regla afectada en el mapa de abajo y su test.
2. Escribir o cambiar primero el test que describe el comportamiento nuevo y
   verlo fallar (`npx vitest run <archivo>`).
3. Implementar en la capa que corresponde. La regla va en `src/domain`; el
   controlador no decide nada.
4. Ver pasar ese test y después `npm run verify`.
5. Si el cambio altera una regla del enunciado, el contrato o una decisión del
   documento de diseño, actualizar en el mismo cambio la sección 2 del
   documento, el README y este archivo. Decir en el resumen qué invariantes de
   la lista toca.

Si se pide un cambio de regla (otros reintentos, otra franja, un campo nuevo),
se hace: la petición manda sobre el enunciado. Se pregunta solo cuando la
petición es ambigua o rompe un invariante sin decirlo (por ejemplo, permitir
dos recordatorios pendientes por cita).

## Comandos

```bash
npm ci
npm run db:up           # levanta solo el Postgres del compose (lo necesitan los e2e)
npm run verify          # lint + tipos + unitarios + e2e: el «terminado»
npx vitest run src/domain/reminder-schedule.spec.ts   # un unitario
npm run test:e2e -- test/reminder-job.e2e-spec.ts     # un e2e
docker compose up --build -d --wait                   # api :3000, db, provider :4010
scripts/smoke.sh        # recorrido completo contra el compose levantado
```

- `verify` ejecuta `lint` (oxlint con reglas que usan los tipos), `typecheck`
  (`tsc --noEmit`, que también revisa los specs; `nest build` no los mira),
  `test` y `test:e2e`.
- Los e2e usan la base `clinicsay_test` (`TEST_DATABASE_URL`) y lanzan su propio
  proveedor en el puerto 4011, así que no interfieren con un compose levantado.
  El `globalSetup` (`test/support/global-setup.ts`) crea esa base si no existe
  y se niega a arrancar si el 4011 ya tiene un proveedor.
- Un cambio está terminado cuando `npm run verify` pasa y se ha visto la
  salida.

## Mapa de reglas

| Regla | Dónde vive | Test |
|---|---|---|
| Hora de envío (día anterior, zona IANA, cambio de horario) y franja `[21:00, 09:00)` | `src/domain/reminder-schedule.ts` (`planReminder`) | `reminder-schedule.spec.ts` |
| Zona efectiva (`virtual` → `Europe/Madrid`) y zonas válidas | `src/domain/time-zones.ts` | `time-zones.spec.ts` |
| Texto exacto del mensaje | `src/domain/reminder-message.ts` | `reminder-message.spec.ts` |
| Transiciones de cita y recordatorio (reprogramar, cancelar, `too_late`) | `src/domain/appointment.ts`, `src/domain/reminder.ts` | sus `*.spec.ts` |
| Reintentos (`RETRY_DELAYS_MINUTES`, `MAX_ATTEMPTS`) | `src/domain/retry-policy.ts` | `retry-policy.spec.ts` |
| Respuesta del proveedor → `sent`, reintento o `failed` | `src/domain/provider-outcome.ts` | `provider-outcome.spec.ts` |
| Lectura de SI/NO | `src/domain/patient-reply.ts` | `patient-reply.spec.ts` |
| Pasada del job (bloqueo, orden de descartes, llamada, guardado) | `src/application/reminders/run-reminder-pass.ts` | `test/reminder-job.e2e-spec.ts` |
| Webhook (deduplicación, cita destino) | `src/application/inbound/handle-inbound-message.ts` | `test/webhook.e2e-spec.ts` |
| Crear, reprogramar y cancelar citas | `src/application/appointments/*.ts` | `test/appointments.e2e-spec.ts`, `test/reschedule-cancel.e2e-spec.ts` |
| Formato de errores y validación | `src/http/error.filter.ts`, `src/http/validation.ts` | `validation.spec.ts`, e2e |
| Formato de fechas de salida | `src/http/api-date.ts` (`toApiDate`) | `api-date.spec.ts` |
| Esquema e índices (migraciones listadas en `mikro-orm.config.ts`) | `src/infrastructure/persistence/migrations/` | `test/persistence.e2e-spec.ts` |
| `GET /health`: 200 con la base migrada, 503 si no responde | `src/infrastructure/persistence/health.controller.ts` | `test/health.e2e-spec.ts` |

Cada PR que crea, mueve o renombra uno de estos archivos actualiza la tabla.

## Arquitectura

Las dependencias van hacia dentro: `http` → `application` → `domain`.
`infrastructure` implementa los puertos de `application`.

| Carpeta | Contiene | Nunca usa |
|---|---|---|
| `src/domain` | Tipos y funciones puras | `@nestjs/*`, `@mikro-orm/*`, red, `process.env`, la hora actual |
| `src/application` | Un caso de uso por archivo (clases sin decoradores) y los puertos (`Clock`, `SettableClock`, `Transactions`, repositorios, `MessageProvider`) como clases abstractas | `@mikro-orm/*`, `src/http`, `src/infrastructure` |
| `src/infrastructure` | Entidades `defineEntity`, repositorios, migraciones, cliente del proveedor, relojes y el controlador de `/health`, que es puro adaptador de la base | `src/http` |
| `src/http` | Controladores finos, DTOs con class-validator, presentadores, filtro de errores | `@mikro-orm/*` |
| `src/app.module.ts`, `src/app.factory.ts`, `src/main.ts`, `src/config/` | Composición: cablea todo | — |

- `test/architecture.spec.ts` comprueba los imports de `src/domain` y
  `src/application`; si falla, el cambio está en la capa equivocada.
- Los casos de uso se registran en `app.module.ts` con `useFactory`; los
  puertos son los tokens de inyección.
- Los repositorios devuelven tipos del dominio, nunca entidades de MikroORM.
- Cada caso de uso que escribe abre su transacción con `Transactions.run(...)`.
  Nunca se usa el `EntityManager` global.
- La configuración de MikroORM sale solo de
  `src/infrastructure/persistence/mikro-orm.config.ts`, para la app y los
  tests.

### Recetas

- **Campo nuevo en una entidad:** migración nueva (y, si es un estado, el
  `check` correspondiente) → `entities.ts` → tipo del dominio → repositorio
  (fila ↔ dominio) → DTO de entrada y presentador de salida → test e2e.
- **Caso de uso nuevo:** clase en `src/application/<área>/` que recibe sus
  puertos por constructor → `useFactory` en `app.module.ts` → controlador.
- **Endpoint nuevo:** solo si está en `openapi.yaml` o se pide expresamente. Su
  test e2e va en `test/<área>.e2e-spec.ts`.
- **Migración:** archivo nuevo en `src/infrastructure/persistence/migrations/`
  con SQL escrito a mano, añadido a `migrationsList`. Nunca se edita una
  migración ya mergeada. La cadena completa crea la base desde cero (el CI
  parte de una base vacía). Nombres de índices y restricciones de menos de 63
  caracteres.

## Invariantes

Cada uno tiene un test; si un cambio lo rompe, ese test debe fallar.

- **Hora:** la hora de negocio sale siempre del puerto `Clock`. Nada de
  `new Date()` sin argumentos, `Date.now()` ni `now()` de Postgres en
  reglas, casos de uso o SQL. Con `CLOCK_MODE=test` el reloj usa la hora del
  sistema hasta el primer `PUT /test/clock` y desde ahí queda congelado hasta el
  siguiente. Ese controlador solo se registra en ese
  modo y fija la hora a través del puerto `SettableClock`.
- **Fechas:** se guardan en `timestamptz` y salen en UTC con `Z` por
  `toApiDate`, sin milisegundos si son cero (`2027-03-27T09:00:00Z`). Una
  entrada sin zona es 400. La hora local se calcula con Luxon y la zona IANA.
- **Errores:** siempre `{ "error": "<mensaje>" }`. Orden: esquema (400) →
  existencia (404) → estado (409) → regla de negocio (400).
- **Ids:** un id que no es UUID, en la ruta o en el cuerpo, es 404, igual que
  uno que no existe. Por eso los DTOs no usan `@IsUUID()` (daría 400).
- **Un pendiente por cita:** el índice único parcial `reminder_one_pending` lo
  garantiza. Reprogramar pasa el pendiente a `cancelled` y crea otro; un
  recordatorio ya `sent` se queda `sent`; una cita `confirmed` vuelve a
  `scheduled`.
- **Orden:** los recordatorios de una cita se listan por id (UUIDv7 generado en
  la app), no por fecha, porque con el reloj congelado las fechas empatan.
- **Envío sin duplicados:** una transacción por recordatorio, tomado con
  `FOR UPDATE SKIP LOCKED`. Dentro se vuelven a comprobar las reglas, se llama
  al proveedor con `Idempotency-Key` = id del recordatorio y se guarda el
  resultado antes del `COMMIT`. La llamada va dentro de la transacción para que
  otra pasada no tome el mismo intento. La misma clave en todos los intentos es
  lo que evita que el paciente reciba dos mensajes tras un 504.
- **Descartes al enviar**, en este orden: `too_late` (la cita ya empezó),
  `no_phone`, `opted_out`. Ninguno llama al proveedor.
- **Proveedor:** 202 o 200 (duplicado) → `sent`. Cualquier 4xx → `failed`, sin
  reintento. 5xx, error de red o más de 5000 ms → reintento. `attempts` cuenta
  las llamadas hechas al proveedor.
- **Reintentos:** `RETRY_DELAYS_MINUTES = [1, 5]`, 3 intentos como mucho. Es la
  única definición de esos valores. El reintento mueve `next_attempt_at`, no
  `scheduledFor`, y no espera a que acabe la franja de silencio.
- **Franja de silencio:** `[21:00, 09:00)` en hora local; lo que cae dentro pasa
  a las 09:00 siguientes. Las citas con `virtual: true` usan `Europe/Madrid`
  para la hora, la franja y el texto. `virtual` es una extensión opcional del
  contrato: por defecto es `false` y la respuesta solo lo incluye cuando vale
  `true`, para que una cita normal tenga exactamente la forma del contrato.
- **Texto:** el de `openapi.yaml`, carácter por carácter.
- **Webhook:** responde 200 aunque ignore el mensaje (400 solo con un cuerpo
  fuera de esquema). El `messageId` se registra en la misma transacción que el
  efecto, y uno repetido no hace nada. La respuesta se aplica a la cita del
  último recordatorio enviado a ese teléfono (por `send_seq`, no por `sentAt`)
  entre las que no han empezado ni están canceladas.

## Tests

- Test primero en todo cambio de comportamiento. Un bug se arregla empezando
  por un test que lo reproduce, y se comprueba que falla sin el arreglo.
- Unitarios para el dominio, sin Nest ni base. E2e con supertest contra la app
  real (`createApp`), Postgres real y el proveedor real.
- El proveedor no se mockea. Los fallos se provocan con su API de
  administración (`POST /admin/rules` con `unavailable`, `lost-response` o
  `reject`) y se comprueban con `GET /admin/requests`. Las dos excepciones:
  el timeout se prueba con un `providerTimeoutMs` bajo en `startTestApp`, y el
  error de red con un `providerUrl` a un puerto cerrado. La caída de la base
  se prueba poniendo entre la app y Postgres un proxy TCP
  (`test/support/tcp-proxy.ts`) y cortándolo.
- Cada test crea sus propios datos y fija la hora con `setClock`. Las reglas del
  proveedor y los recordatorios pendientes son globales, así que cada e2e
  empieza con `t.reset()` (vacía las tablas y el proveedor). Los e2e corren en
  serie.
- La app se cierra en `afterAll` con `close()`, nunca cerrando la conexión a
  mano.
- Los valores esperados salen del enunciado o del contrato (cambio de horario
  del último domingo de marzo y de octubre, Canarias, bordes de las 21:00 y las
  09:00), no de lo que devuelve el código.

## Trampas del stack

- ESM: los imports relativos terminan en `.js`, no existe `__dirname` (se usa
  `import.meta.dirname`) y los mocks son `vi.fn()`.
- Una clase que se usa como token de inyección o como tipo de `@Body()` no se
  importa con `import type`: se pierde la metadata y la inyección o la
  validación fallan sin avisar.
- El `ValidationPipe` global usa `whitelist` y `transform`, sin conversión
  implícita: `"true"` no es un booleano.
- La plantilla de Nest sugiere `@nestjs/idempotency`, `@nestjs/resilience`,
  Nest Observe y trae skills genéricas en `.claude/skills/`. Aquí no se usan: la idempotencia y los reintentos son
  reglas del enunciado y viven en el dominio y en Postgres, donde se pueden
  probar con el reloj de test.

## Reglas de código

Se aplican a todo código nuevo y a los archivos que un cambio toca.

- **SOLID, con inyección de dependencias.** Una responsabilidad por archivo
  (un caso de uso, una regla, un repositorio). Los casos de uso reciben sus
  puertos por constructor y dependen de las clases abstractas de
  `src/application/ports/`, nunca de una implementación; las implementaciones
  se eligen solo en `app.module.ts`. Fuera de la composición y de los tests,
  nada hace `new` de un repositorio, un cliente HTTP o un reloj.
- **Errores propios, traducidos a HTTP en un solo sitio.** Los casos de uso
  de `application` lanzan errores tipados de `src/application/errors.ts`
  (`ValidationError`, `NotFoundError`, `ConflictError`); si hace falta otro,
  se añade ahí y se traduce en `ErrorFilter`. `ServiceUnavailableError` (503)
  es el de una dependencia caída y lo lanza el adaptador de `/health` cuando
  la base no responde. Solo `src/http` conoce los
  códigos HTTP: los casos de uso no lanzan `HttpException` ni importan
  `@nestjs/*`, para que se prueben sin Nest.
- **`domain` no importa `application`** (lo comprueba
  `test/architecture.spec.ts`), así que no lanza esos errores. Una regla de
  negocio que puede no cumplirse devuelve un resultado (como `skipReason` en
  `ReminderPlan`) y el caso de uso decide el error. Un `Error` simple solo
  señala un fallo de programación, como una zona que debió validarse antes, y
  el filtro lo convierte en 500.
- **`try/catch` en los límites con E/S** (proveedor, base de datos,
  `/health`): convierte el fallo externo en un resultado tipado
  (`ProviderResult`, 503) o en un error propio. Cada `catch` traduce, registra
  o relanza; ninguno silencia.
- **Sin `any` en ningún caso**, tampoco en tests ni como `as any`. Lo
  desconocido es `unknown` y se estrecha. `as` solo para `as const` o en un
  límite justificado con un comentario.
- **JSDoc en cada método público y función exportada de `src/`**: qué hace,
  `@param` cuando el nombre no basta y `@throws` con los errores propios que
  puede lanzar. Dentro del cuerpo, comentarios solo donde el porqué no es
  obvio (una regla del enunciado, una decisión de concurrencia, un borde de
  zona horaria).
- **Tests con Vitest**, no con Jest: la API es la misma (`describe`, `it`,
  `expect`) y los mocks son `vi.fn()`. Si una petición o una skill pide un
  ejemplo en Jest, se escribe en Vitest.

## Estilo

- TypeScript estricto.
- Toda promesa se espera (`typescript/no-floating-promises` es error).
- Identificadores en inglés; README, documentos y commits en español; mensajes
  de error de la API en inglés y cortos.
- No se añaden dependencias sin explicar el motivo en la PR.

## Git y CI

- Nunca se commitea en `main`. Antes de editar se crea la rama desde `main`
  (`git switch -c feat/x main`); con `origin/main` como base se añade
  `--no-track`.
- Conventional Commits en español (`feat(recordatorios): …`), pequeños y con
  los tests en verde.
- Cada rama entra por PR a `main` con los checks `checks` y `compose` en verde,
  con merge commit (sin squash ni `--force`). La PR dice qué cambia, por qué,
  si hay migración y qué comandos se corrieron con su resultado.
- Lo que se sube se redacta en neutro y sin datos personales.
- CI: imágenes con tag exacto (`postgres:17-alpine`, `node:24-alpine`),
  `timeout-minutes` en cada job y nunca `continue-on-error`.
