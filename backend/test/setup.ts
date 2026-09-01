import { loadConfig, setConfig } from '../src/config.js';

/** Deterministic config for unit tests. No database or network required. */
export function useTestConfig(overrides: Record<string, string> = {}): void {
  setConfig(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/reseats_test',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      API_KEY_PEPPER: 'test-pepper',
      SESSION_JWT_SECRET: 'test-session-secret',
      CARD_PROVIDERS: 'mock',
      DEFAULT_CARD_PROVIDER: 'mock',
      MATCH_WINDOW_SECONDS: '900',
      ...overrides,
    } as NodeJS.ProcessEnv),
  );
}
