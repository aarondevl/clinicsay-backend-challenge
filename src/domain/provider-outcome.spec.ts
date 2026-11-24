import {
  classifyProviderResult,
  type ProviderResult,
  type SendOutcome,
} from './provider-outcome.js';

const response = (status: number): ProviderResult => ({
  kind: 'response',
  status,
});

describe('classifyProviderResult', () => {
  it.each<[string, SendOutcome, ProviderResult]>([
    ['202 (aceptado)', 'delivered', response(202)],
    ['200 (ya lo tenía y no lo reenvía)', 'delivered', response(200)],
    ['503 (no se entregó)', 'retry', response(503)],
    ['504 (puede haberse entregado)', 'retry', response(504)],
    ['500', 'retry', response(500)],
    ['un error de red', 'retry', { kind: 'network_error' }],
    ['más de 5 s sin respuesta', 'retry', { kind: 'timeout' }],
    ['422 (rechazado)', 'rejected', response(422)],
    ['400 (petición inválida)', 'rejected', response(400)],
    ['404', 'rejected', response(404)],
    ['499', 'rejected', response(499)],
  ])('%s → %s', (_label, outcome, result) => {
    expect(classifyProviderResult(result)).toBe(outcome);
  });

  // Fuera de la tabla del enunciado. Cualquier 2xx es un éxito HTTP: un
  // proveedor real que acepte con 201 o 204 no debe acabar en `failed`.
  it.each([201, 204, 299])('un %s también es entregado', (status) => {
    expect(classifyProviderResult(response(status))).toBe('delivered');
  });

  // Lo que no es éxito ni 4xx se reintenta: con la misma clave es seguro.
  it.each([100, 199, 302, 399, 600])('un %s se reintenta', (status) => {
    expect(classifyProviderResult(response(status))).toBe('retry');
  });
});
