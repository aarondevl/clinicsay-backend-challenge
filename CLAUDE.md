@AGENTS.md

## Notas para Claude Code

- Responde en español.
- Antes de dar algo por terminado, ejecuta `npm run verify` y muestra la
  salida. Antes de abrir una PR, además, `docker compose up --build -d --wait`
  y `scripts/smoke.sh`. La skill `verificar` (`.claude/skills/verificar/`)
  hace los dos pasos con el proyecto de compose `clinicsay` y dice qué hacer
  si algo falla.
- Las preguntas y revisiones son de solo lectura: no se edita nada hasta que
  se pide un cambio.
- Al escribir código se cumplen las «Reglas de código» de `AGENTS.md`: SOLID
  con inyección de dependencias por puertos, errores propios que solo
  `src/http` traduce a HTTP, `try/catch` en los límites con E/S, nada de `any`
  y JSDoc en los métodos públicos. Los tests son de Vitest aunque se pida Jest.
- El trabajo se entrega en el repo (archivos, `npm run verify`, PR), no como
  un bloque de código en la respuesta.
