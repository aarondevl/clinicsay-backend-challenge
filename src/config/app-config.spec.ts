import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  it('usa el puerto 3000, 5000 ms de timeout y el reloj del sistema por defecto', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.providerTimeoutMs).toBe(5000);
    expect(config.clockMode).toBe('system');
  });

  it('usa por defecto la base del compose en el puerto 55432 del host', () => {
    // El compose no publica el 5432 para no chocar con un Postgres local.
    expect(loadConfig({}).databaseUrl).toBe(
      'postgres://clinicsay:clinicsay@localhost:55432/clinicsay',
    );
  });

  it('activa el reloj de pruebas solo con CLOCK_MODE=test', () => {
    expect(loadConfig({ CLOCK_MODE: 'test' }).clockMode).toBe('test');
    expect(loadConfig({ CLOCK_MODE: 'TEST' }).clockMode).toBe('system');
  });

  it('lee el puerto, la base y el proveedor del entorno', () => {
    const config = loadConfig({
      PORT: '8080',
      DATABASE_URL: 'postgres://u:p@db:5432/x',
      PROVIDER_URL: 'http://provider:4010',
    });
    expect(config).toMatchObject({
      port: 8080,
      databaseUrl: 'postgres://u:p@db:5432/x',
      providerUrl: 'http://provider:4010',
    });
  });
});
