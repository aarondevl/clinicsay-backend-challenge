---
name: verificar
description: Úsala antes de dar por terminado un cambio en este repositorio, antes de abrir o actualizar una PR y cuando falle el CI (`checks` o `compose`). Ejecuta lint, tipos, unitarios y e2e (`npm run verify`) y la prueba de humo contra el compose del proyecto `clinicsay`, y dice qué hacer si algo falla.
---

# Verificar

Un cambio está terminado cuando pasan los dos bloques de abajo y se ha
mostrado su salida. «Debería pasar» no cuenta: se ejecuta y se lee.

## 1. Lint, tipos, unitarios y e2e

```bash
npm ci                                  # si falta node_modules o cambió package-lock.json
export COMPOSE_PROJECT_NAME=clinicsay   # un solo proyecto de compose para todos los worktrees
npm run db:up                           # Postgres del compose en 127.0.0.1:55432
LOG="${TMPDIR:-/tmp}/clinicsay-verify.log"
npm run verify > "$LOG" 2>&1; echo "exit=$?"; tail -40 "$LOG"
```

`verify` es `lint` (oxlint + `prettier --check`) → `typecheck` → `test` →
`test:e2e`, y se para en el primero que falla. Muestra el `exit` y el resumen
de Vitest (archivos y tests de unitarios y de e2e); si falla, el detalle está
en `$LOG`.

## 2. Humo contra el compose

```bash
docker compose -p clinicsay up --build -d --wait   # api :3000, db, provider :4010
./scripts/smoke.sh; echo "exit=$?"
docker compose -p clinicsay down -v                # siempre al terminar, también si falló
```

El humo recorre reloj → clínica → paciente → cita → pasada y comprueba
`{"processed":1}`, el texto exacto y la `Idempotency-Key` en el proveedor.
Termina con `smoke: OK` y `exit=0`. Antes de bajar el compose tras un fallo,
lee `docker compose -p clinicsay logs api`.

## Si algo falla

Un rojo es un hallazgo, no un estorbo: se busca la causa
(superpowers:systematic-debugging) antes de tocar nada, y nunca se cambia un
test o el humo para que pase. Lo que no tenga que ver con el cambio se cuenta
en el resumen en vez de arreglarse de paso.

| Dónde | Síntoma | Qué hacer |
|---|---|---|
| `lint` | `prettier --check` lista archivos | `npm run format` y revisar el diff |
| `lint` | regla de oxlint (`no-floating-promises`, `no-explicit-any`) | Corregir el código: `await` la promesa, `unknown` y estrechar. Sin `// oxlint-disable` |
| `typecheck` | error en un `*.spec.ts` | `tsc --noEmit` también mira los tests; `nest build` no |
| `test` | un unitario | `npx vitest run <archivo>`; la regla está en el mapa de `AGENTS.md` |
| `test` | `test/architecture.spec.ts` | Un import en la capa equivocada: mover el código, no el test |
| `test:e2e` | `ECONNREFUSED 127.0.0.1:55432` | Falta `npm run db:up` (con `COMPOSE_PROJECT_NAME=clinicsay`) |
| `test:e2e` | «El puerto 4011 ya tiene un proveedor» | Otro e2e en curso o un proveedor huérfano: esperar o cerrar ese proceso (`lsof -i :4011`), nunca de otro proyecto |
| `test:e2e` | uno de concurrencia o de bloqueos falla a veces | Repetirlo con `npm run test:e2e -- <archivo>` y buscar la causa; no subir esperas a ciegas |
| compose | `port is already allocated` (3000, 4010 o 55432) | Otro compose del mismo repo con otro nombre de proyecto: `docker compose ls`. No se borran contenedores, redes ni volúmenes de otros proyectos; si Docker no tiene recursos, avisar |
| compose | la api no llega a `healthy` | `docker compose -p clinicsay logs api` (migraciones, conexión a la base) |
| humo | `no se pudo llamar a ...` | El compose no está levantado o no responde en ese puerto |
| humo | `se esperaba 201/204/200 y llegó ...` | El paso que falla y el cuerpo de error salen en el mensaje; reproducirlo con curl |
| humo | `se esperaba {"processed":1}` | La pasada trató otros o ninguno: hora de envío, filtro de `lockNextDue` o recuento de `RunReminderPass` |
| humo | `texto del mensaje` o `Idempotency-Key` | `src/domain/reminder-message.ts` o la llamada en `RunReminderPass` |

## Qué no se hace

- No se modifica `provider/` ni el bloque `provider` de `docker-compose.yml`.
- No se usan `--force`, `--no-verify` ni `continue-on-error` para sacar un
  verde.
- No se da por bueno un verde sin haber visto la salida.
