import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),

  // Browser origins allowed to call the API. The site and the API are separate
  // origins in this deployment, so this must list the site. Empty means
  // "reflect any origin" — fine locally, refused at boot in production.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: int(10),

  ENCRYPTION_KEY: z.string().min(1),
  API_KEY_PEPPER: z.string().min(1),
  SESSION_JWT_SECRET: z.string().min(1),

  CARD_PROVIDERS: z
    .string()
    .default('mock')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  DEFAULT_CARD_PROVIDER: z.string().default('mock'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  WEBHOOK_MAX_ATTEMPTS: int(8),
  WEBHOOK_TIMEOUT_MS: int(8000),
  WEBHOOK_WORKER_ENABLED: bool(true),
  WEBHOOK_WORKER_INTERVAL_MS: int(5000),

  MATCH_WINDOW_SECONDS: int(900),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  // Allow-all CORS is a development convenience. Shipping it would let any page
  // on the internet call the demo endpoints with a visitor's browser, so fail
  // at boot rather than discovering it in production.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS.length === 0) {
    throw new Error(
      'CORS_ORIGINS must list the allowed site origins in production, ' +
        'e.g. CORS_ORIGINS=https://reseats.org,https://www.reseats.org',
    );
  }

  return parsed.data;
}

export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper — lets suites inject config without touching process.env. */
export function setConfig(c: Config): void {
  cached = c;
}
