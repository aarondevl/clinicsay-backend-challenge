export type ClockMode = 'test' | 'system';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  providerUrl: string;
  clockMode: ClockMode;
  providerTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl:
      env.DATABASE_URL ??
      'postgres://clinicsay:clinicsay@localhost:5432/clinicsay',
    providerUrl: env.PROVIDER_URL ?? 'http://localhost:4010',
    clockMode: env.CLOCK_MODE === 'test' ? 'test' : 'system',
    providerTimeoutMs: Number(env.PROVIDER_TIMEOUT_MS ?? 5000),
  };
}
