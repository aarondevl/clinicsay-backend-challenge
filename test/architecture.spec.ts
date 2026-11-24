import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const pattern =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;
  return [...code.matchAll(pattern)].map((m) => m[1] ?? m[2]);
}

/** Devuelve los imports de `layer` que caen en un paquete o carpeta prohibida. */
function forbiddenImports(
  layer: string,
  packages: string[],
  layers: string[],
): string[] {
  return sourceFiles(join(SRC, layer)).flatMap((file) =>
    importsOf(file)
      .filter((spec) => {
        if (packages.some((p) => spec === p || spec.startsWith(`${p}/`))) {
          return true;
        }
        if (!spec.startsWith('.')) return false;
        const target = relative(SRC, resolve(dirname(file), spec));
        return layers.some((l) => target === l || target.startsWith(`${l}/`));
      })
      .map((spec) => `${relative(ROOT, file)} → ${spec}`),
  );
}

describe('arquitectura', () => {
  it('src/domain no importa @nestjs, @mikro-orm, application, infrastructure ni http', () => {
    expect(
      forbiddenImports(
        'domain',
        ['@nestjs', '@mikro-orm'],
        ['application', 'infrastructure', 'http'],
      ),
    ).toEqual([]);
  });

  it('src/application no importa @nestjs, @mikro-orm, infrastructure ni http', () => {
    expect(
      forbiddenImports(
        'application',
        ['@nestjs', '@mikro-orm'],
        ['infrastructure', 'http'],
      ),
    ).toEqual([]);
  });
});
