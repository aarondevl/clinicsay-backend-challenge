import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { parse } from 'yaml';

// ajv-formats es CommonJS: en ESM el default es `module.exports`, y el plugin
// está también en su propiedad `default`, que es la que tipa TypeScript.
const addFormats = ajvFormats.default;

const OPENAPI_PATH = join(import.meta.dirname, '../../openapi.yaml');

/** `$id` con el que se registran en Ajv los `components/schemas` del contrato. */
const COMPONENTS_ID = 'openapi.yaml';
const COMPONENT_REF = '#/components/schemas/';

/** Métodos de un Path Item de OpenAPI 3.1. */
const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/** Método HTTP de una operación de `openapi.yaml`, en minúsculas como allí. */
export type HttpMethod = (typeof METHODS)[number];

/** Lo que el helper lee de una respuesta; una de supertest lo cumple. */
export interface ContractResponse {
  status: number;
  body: unknown;
  /** Cuerpo sin interpretar; vacío (o ausente) si no hay cuerpo. */
  text: string | undefined;
  /** Tipo MIME sin parámetros (`application/json`), vacío sin `content-type`. */
  type: string;
}

/** Comprueba respuestas contra `openapi.yaml` y lleva la cuenta de las vistas. */
export interface ContractChecker {
  /**
   * Falla (lanza) si la respuesta no cumple el contrato en modo estricto:
   * código no documentado para la operación, cuerpo fuera del esquema (sin
   * propiedades de más y con fechas UTC con `Z`, como `toApiDate`), un 4xx
   * que no es exactamente `{ "error": <string> }` o un cuerpo donde el
   * contrato no tiene contenido.
   * @param method Método de la operación, como en `openapi.yaml`.
   * @param path Ruta de la operación tal como está en `openapi.yaml`, con sus
   *   parámetros (`/appointments/{id}`), no la URL pedida.
   */
  check(res: ContractResponse, method: HttpMethod, path: string): void;
  /**
   * Respuestas documentadas (`POST /appointments 409`) que `check` todavía no
   * ha visto cumplir el contrato, en el orden de `openapi.yaml`.
   */
  uncovered(): string[];
}

type Schema = Record<string, unknown>;

/**
 * Fecha de una respuesta como la escribe `toApiDate`: UTC con `Z` y, si hay
 * milisegundos, tres cifras que no son todas cero. `format: date-time`
 * (ajv-formats) comprueba además que la fecha exista.
 */
const API_DATE_TIME =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.(?!000)\\d{3})?Z$';

/**
 * Propiedades que el repo añade a un esquema del contrato. `virtual` es la
 * extensión de las citas virtuales («Franja de silencio» en AGENTS.md) y solo
 * aparece con `true`.
 */
const EXTENSIONS: Record<string, Record<string, Schema>> = {
  Appointment: { virtual: { const: true } },
};

/** Cuerpo de un 4xx según `info.description`: exactamente `{ "error": "<mensaje>" }`. */
const ERROR_SCHEMA: Schema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

/**
 * Cuerpo de las respuestas sin contenido en el contrato que tienen uno por
 * convención del repo. Las demás (el 204 del reloj, el 200 del webhook) van
 * vacías.
 */
const NO_CONTENT_BODIES: Record<string, unknown> = {
  'GET /health 200': { status: 'ok' },
};

/** Campos fijos del Schema Object de OpenAPI 3.1 que no son de JSON Schema. */
const OPENAPI_SCHEMA_KEYWORDS = [
  'example',
  'discriminator',
  'xml',
  'externalDocs',
];

/** Palabras clave de JSON Schema 2020-12 que contienen subesquemas. */
const SUBSCHEMA_MAPS = [
  'properties',
  'patternProperties',
  '$defs',
  'dependentSchemas',
];
const SUBSCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SUBSCHEMA_VALUES = [
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`openapi.yaml: ${where} is not an object`);
  }
  return value;
}

function isMethod(key: string): key is HttpMethod {
  return (METHODS as readonly string[]).includes(key);
}

function subschemas(schema: Schema): Schema[] {
  const found: Schema[] = [];
  for (const key of SUBSCHEMA_MAPS) {
    const map = schema[key];
    if (isRecord(map)) found.push(...Object.values(map).filter(isRecord));
  }
  for (const key of SUBSCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) found.push(...list.filter(isRecord));
  }
  for (const key of SUBSCHEMA_VALUES) {
    const value = schema[key];
    if (isRecord(value)) found.push(value);
  }
  return found;
}

/**
 * Modo estricto sobre un esquema de la copia en memoria (el archivo no se
 * toca): un objeto con `properties` no admite otras y un `date-time` lleva el
 * patrón de `toApiDate`. Además apunta los `$ref` a `components/schemas` al
 * esquema que registra `createContractChecker`.
 */
function tighten(schema: Schema, where: string): void {
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith(COMPONENT_REF)) {
      throw new Error(
        `contract: ${where}: only $ref to ${COMPONENT_REF}* is supported`,
      );
    }
    schema.$ref = `${COMPONENTS_ID}#/$defs/${schema.$ref.slice(COMPONENT_REF.length)}`;
  }
  if (schema.format === 'date-time') {
    if (schema.pattern !== undefined) {
      throw new Error(
        `contract: ${where} already has a pattern; combine it with API_DATE_TIME`,
      );
    }
    schema.pattern = API_DATE_TIME;
  }
  if (
    isRecord(schema.properties) &&
    schema.additionalProperties === undefined
  ) {
    schema.additionalProperties = false;
  }
  for (const child of subschemas(schema)) tighten(child, where);
}

/** Lee `openapi.yaml`; cada llamada devuelve un objeto nuevo. */
function loadOpenApi(): Schema {
  const document: unknown = parse(readFileSync(OPENAPI_PATH, 'utf8'));
  return asRecord(document, 'the document');
}

function describeErrors(errors: ErrorObject[]): string {
  return errors
    .map((error) => {
      const where = error.instancePath || '(body)';
      const params: Record<string, unknown> = error.params;
      const detail =
        error.keyword === 'additionalProperties'
          ? ` (${String(params.additionalProperty)})`
          : isRecord(error.data) || Array.isArray(error.data)
            ? ''
            : `, got ${JSON.stringify(error.data)}`;
      return `${where} ${error.message ?? error.keyword}${detail}`;
    })
    .join('; ');
}

function bodyOf(res: ContractResponse): string {
  return res.text ? `\nbody: ${res.text.slice(0, 1000)}` : '\n(empty body)';
}

/**
 * Crea un comprobador del contrato a partir de `openapi.yaml` (OpenAPI 3.1,
 * JSON Schema 2020-12). Los esquemas de las respuestas y de
 * `components/schemas` pasan a modo estricto en una copia en memoria, y sus
 * `$ref` se resuelven dentro de esa copia. Cada comprobador lleva su propia
 * cuenta de cobertura.
 */
export function createContractChecker(): ContractChecker {
  const contract = loadOpenApi();

  const components = asRecord(contract.components, 'components');
  const schemas = asRecord(components.schemas, 'components.schemas');
  for (const [name, schema] of Object.entries(schemas)) {
    tighten(asRecord(schema, name), name);
  }
  for (const [name, extra] of Object.entries(EXTENSIONS)) {
    const properties = asRecord(
      asRecord(schemas[name], name).properties,
      `${name}.properties`,
    );
    for (const [property, schema] of Object.entries(extra)) {
      if (property in properties) {
        throw new Error(
          `contract: openapi.yaml already declares ${name}.${property}; drop it from EXTENSIONS`,
        );
      }
      properties[property] = schema;
    }
  }

  // operación (`POST /appointments`) → código → esquema del cuerpo o null
  const operations = new Map<string, Map<string, Schema | null>>();
  for (const [path, rawItem] of Object.entries(
    asRecord(contract.paths, 'paths'),
  )) {
    const item = asRecord(rawItem, path);
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!isMethod(method)) continue;
      const operationKey = `${method.toUpperCase()} ${path}`;
      const operation = asRecord(rawOperation, operationKey);
      const responses = new Map<string, Schema | null>();
      for (const [status, rawResponse] of Object.entries(
        asRecord(operation.responses, `${operationKey} responses`),
      )) {
        const key = `${operationKey} ${status}`;
        const response = asRecord(rawResponse, key);
        if (response.content === undefined) {
          responses.set(status, null);
          continue;
        }
        const content = asRecord(response.content, `${key} content`);
        const types = Object.keys(content);
        if (types.length !== 1 || types[0] !== 'application/json') {
          throw new Error(
            `contract: ${key} has content other than application/json`,
          );
        }
        const media = asRecord(
          content['application/json'],
          `${key} application/json`,
        );
        const schema = asRecord(media.schema, `${key} schema`);
        tighten(schema, key);
        responses.set(status, schema);
      }
      operations.set(operationKey, responses);
    }
  }

  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    verbose: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  ajv.addVocabulary(OPENAPI_SCHEMA_KEYWORDS);
  // Solo los esquemas, no el documento entero: el modo estricto de Ajv
  // rechazaría `openapi`, `info` o `paths` como palabras clave desconocidas.
  ajv.addSchema({ $id: COMPONENTS_ID, $defs: schemas });
  const errorBody = ajv.compile(ERROR_SCHEMA);
  const validators = new Map<Schema, ValidateFunction>();

  const exercised = new Set<string>();

  function validate(
    validator: ValidateFunction,
    data: unknown,
    prefix: string,
    res: ContractResponse,
  ): void {
    if (validator(data)) return;
    throw new Error(
      `${prefix}: ${describeErrors(validator.errors ?? [])}${bodyOf(res)}`,
    );
  }

  function validatorFor(schema: Schema): ValidateFunction {
    let validator = validators.get(schema);
    if (validator === undefined) {
      validator = ajv.compile(schema);
      validators.set(schema, validator);
    }
    return validator;
  }

  function expectJson(res: ContractResponse, key: string): void {
    if (res.type !== 'application/json') {
      throw new Error(
        `contract: ${key}: expected application/json, got "${res.type}"${bodyOf(res)}`,
      );
    }
  }

  function expectNoContent(res: ContractResponse, key: string): void {
    const convention = NO_CONTENT_BODIES[key];
    if (convention === undefined) {
      if (res.text) {
        throw new Error(
          `contract: ${key}: expected an empty body, the contract has no content${bodyOf(res)}`,
        );
      }
      return;
    }
    if (
      res.type !== 'application/json' ||
      !isDeepStrictEqual(res.body, convention)
    ) {
      throw new Error(
        `contract: ${key}: expected the repo convention ${JSON.stringify(convention)}${bodyOf(res)}`,
      );
    }
  }

  return {
    check(res, method, path) {
      const operationKey = `${method.toUpperCase()} ${path}`;
      const responses = operations.get(operationKey);
      if (responses === undefined) {
        throw new Error(`contract: ${operationKey} is not in openapi.yaml`);
      }
      const status = String(res.status);
      const key = `${operationKey} ${status}`;
      const schema = responses.get(status);
      if (schema === undefined) {
        throw new Error(
          `contract: ${operationKey}: ${status} is not documented (documented: ${[...responses.keys()].join(', ')})${bodyOf(res)}`,
        );
      }

      const isClientError = res.status >= 400 && res.status < 500;
      if (isClientError) {
        expectJson(res, key);
        validate(
          errorBody,
          res.body,
          `contract: ${key}: error body must be exactly { "error": <string> }`,
          res,
        );
      }
      if (schema !== null) {
        expectJson(res, key);
        validate(validatorFor(schema), res.body, `contract: ${key}`, res);
      } else if (!isClientError) {
        expectNoContent(res, key);
      }
      exercised.add(key);
    },

    uncovered() {
      const missing: string[] = [];
      for (const [operationKey, responses] of operations) {
        for (const status of responses.keys()) {
          const key = `${operationKey} ${status}`;
          if (!exercised.has(key)) missing.push(key);
        }
      }
      return missing;
    },
  };
}

const shared = createContractChecker();

/**
 * Falla si `res` no cumple `openapi.yaml` en modo estricto (ver
 * `ContractChecker.check`) y la apunta como ejercitada para
 * `uncoveredResponses`.
 * @param method Método de la operación, como en `openapi.yaml`.
 * @param path Ruta de la operación tal como está en `openapi.yaml`
 *   (`/appointments/{id}`).
 */
export function expectContract(
  res: ContractResponse,
  method: HttpMethod,
  path: string,
): void {
  shared.check(res, method, path);
}

/**
 * Respuestas documentadas en `openapi.yaml` que ningún `expectContract` de
 * este archivo de test ha visto cumplir el contrato (Vitest aísla los módulos
 * por archivo).
 */
export function uncoveredResponses(): string[] {
  return shared.uncovered();
}
