# Prueba técnica de backend · ClinicSay

El enunciado está en [`enunciado.pdf`](enunciado.pdf). Aquí tienes el contrato de la API (`openapi.yaml`), el
proveedor de mensajes simulado (`provider/`) y el `docker-compose.yml` de partida.

Se entrega con el [formulario de entrega](https://docs.google.com/forms/d/e/1FAIpQLSd6OqQxPRvpBz_Cxw8KgOhN9-fsv5idE83PYGsH861BaMITCQ/viewform) hasta el miércoles 25 de noviembre de 2026 a las 17:30 de
Madrid (11:30 en Lima).

## Reglas de código

El detalle está en [`AGENTS.md`](AGENTS.md#reglas-de-código); en resumen:

- SOLID con inyección de dependencias: los casos de uso dependen de puertos
  (clases abstractas) y las implementaciones se cablean en `app.module.ts`.
- Errores propios (`ValidationError`, `NotFoundError`, `ConflictError`) en
  dominio y aplicación; solo la capa HTTP los traduce a 400, 404 y 409 con
  `{ "error": "<mensaje>" }`. `try/catch` en los límites con E/S.
- TypeScript estricto sin `any`.
- JSDoc en los métodos públicos.
- Tests con Vitest.
