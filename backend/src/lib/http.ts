import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { withTransaction } from '../db/index.js';
import {
  beginIdempotent,
  completeIdempotent,
  hashRequest,
  releaseIdempotent,
} from './idempotency.js';
import { badRequest, conflict } from './errors.js';

/**
 * Wraps a mutating merchant handler in the idempotency protocol.
 *
 * Terminals on flaky store wifi retry the same sale repeatedly; without this a
 * customer ends up with four copies of the same receipt.
 */
export async function idempotent<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  handler: (tx: Db) => Promise<{ statusCode: number; body: T }>,
): Promise<unknown> {
  const key = req.headers['idempotency-key'];
  if (key !== undefined && typeof key !== 'string') {
    throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be a single value.');
  }

  if (!key) {
    const result = await withTransaction(handler);
    reply.code(result.statusCode);
    return result.body;
  }

  const requestHash = hashRequest(req.method, req.url, req.body);

  const begin = await withTransaction((tx) => beginIdempotent(tx, scope, key, requestHash));
  if (begin.replay) {
    reply.code(begin.replay.statusCode).header('idempotent-replayed', 'true');
    return begin.replay.body;
  }
  if (begin.inFlight) {
    throw conflict(
      'idempotency_in_progress',
      'A request with this Idempotency-Key is still in flight. Retry shortly.',
    );
  }

  try {
    const result = await withTransaction(handler);
    await withTransaction((tx) =>
      completeIdempotent(tx, scope, key, { statusCode: result.statusCode, body: result.body }),
    );
    reply.code(result.statusCode);
    return result.body;
  } catch (err) {
    // Free the key so the terminal's next retry is allowed to run.
    await withTransaction((tx) => releaseIdempotent(tx, scope, key)).catch(() => undefined);
    throw err;
  }
}

export interface Page {
  limit: number;
  startingAfter: string | null;
}

export function parsePage(query: unknown, defaultLimit = 25, maxLimit = 100): Page {
  const q = (query ?? {}) as Record<string, unknown>;
  const rawLimit = q.limit;
  let limit = defaultLimit;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(String(rawLimit), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw badRequest('invalid_limit', 'limit must be a positive integer.', 'limit');
    }
    limit = Math.min(parsed, maxLimit);
  }
  const startingAfter = typeof q.starting_after === 'string' ? q.starting_after : null;
  return { limit, startingAfter };
}

export function listEnvelope<T>(data: T[], hasMore: boolean): Record<string, unknown> {
  return { object: 'list', data, has_more: hasMore };
}
