import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { demoRoutes } from './routes/demo.js';
import { healthRoutes } from './routes/health.js';
import { posTransactionRoutes } from './routes/pos/transactions.js';
import { posWebhookRoutes } from './routes/pos/webhooks.js';
import { receiptRoutes } from './routes/receipts.js';
import { sessionRoutes } from './routes/sessions.js';

/** Exact origins plus an explicit HTTPS subdomain wildcard for preview hosts. */
export function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.some((entry) => {
    if (entry === origin) return true;
    if (!entry.startsWith('https://*.')) return false;
    try {
      const candidate = new URL(origin);
      const suffix = entry.slice('https://*'.length);
      return candidate.protocol === 'https:' && candidate.hostname.endsWith(suffix)
        && candidate.hostname.length > suffix.length;
    } catch {
      return false;
    }
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-reseats-key"]',
          'req.headers["stripe-signature"]',
          'req.body.payment.fingerprint',
          'req.body.customer.phone',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url, id: req.id }),
      },
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    // Explicit allowlist when configured; reflect the caller only in dev.
    origin: cfg.CORS_ORIGINS.length > 0
      ? (origin, callback) => callback(null, isAllowedOrigin(origin, cfg.CORS_ORIGINS))
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Reseats-Key'],
    maxAge: 86400,
  });
  await app.register(rateLimit, {
    global: false,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.merchant?.merchant.id ?? req.user?.id ?? req.ip,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'api error');
      return reply.code(err.statusCode).send(err.toJSON());
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: {
          type: 'rate_limit_error',
          code: 'too_many_requests',
          message: 'Too many requests. Slow down and retry.',
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'Something went wrong on our end.',
        request_id: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        type: 'not_found_error',
        code: 'unknown_route',
        message: `No route for ${req.method} ${req.url}.`,
      },
    }),
  );

  await app.register(healthRoutes);

  // Merchant (POS) surface — API-key authenticated.
  await app.register(
    async (scope) => {
      await scope.register(posTransactionRoutes);
      await scope.register(posWebhookRoutes);
    },
    { prefix: '/v1/pos' },
  );

  // Customer receipt vault: QR claims, manual uploads, and after-sale help.
  await app.register(sessionRoutes, { prefix: '/v1' });
  await app.register(receiptRoutes, { prefix: '/v1' });
  await app.register(demoRoutes, { prefix: '/v1' });

  return app;
}
