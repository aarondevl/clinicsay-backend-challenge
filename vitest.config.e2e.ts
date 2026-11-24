import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Crea la base de test y lanza el proveedor en el puerto 4011.
    globalSetup: ['./test/support/global-setup.ts'],
    // Los e2e comparten la base y el proveedor de test: corren en serie.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
