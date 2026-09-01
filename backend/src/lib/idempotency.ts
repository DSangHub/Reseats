import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { conflict } from './errors.js';

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path} ${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

type BeginResult =
  | { replay: StoredResponse }
  | { replay: null; inFlight: false }
  | { replay: null; inFlight: true };

/**
 * Reserve an idempotency key.
 *
 * - fresh key      -> row inserted, caller proceeds
 * - completed key  -> stored response returned for replay
 * - in-flight key  -> 409, the terminal should retry shortly
 * - key reused with a different body -> 409, this is an integration bug
 */
export async function beginIdempotent(
  d: Db,
  scope: string,
  key: string,
  requestHash: string,
): Promise<BeginResult> {
  const { rows } = await d.query<{
    status: string;
    request_hash: string;
    response_code: number | null;
    response_body: unknown;
    inserted: boolean;
  }>(
    `with ins as (
       insert into idempotency_keys (scope, key, request_hash)
       values ($1, $2, $3)
       on conflict (scope, key) do nothing
       returning status, request_hash, response_code, response_body, true as inserted
     )
     select * from ins
     union all
     select status, request_hash, response_code, response_body, false as inserted
       from idempotency_keys
      where scope = $1 and key = $2
      limit 1`,
    [scope, key, requestHash],
  );

  const row = rows[0];
  if (!row || row.inserted) return { replay: null, inFlight: false };

  if (row.request_hash !== requestHash) {
    throw conflict(
      'idempotency_key_reuse',
      'This Idempotency-Key was already used with a different request body.',
    );
  }

  if (row.status === 'completed' && row.response_code !== null) {
    return { replay: { statusCode: row.response_code, body: row.response_body } };
  }

  return { replay: null, inFlight: true };
}

export async function completeIdempotent(
  d: Db,
  scope: string,
  key: string,
  response: StoredResponse,
): Promise<void> {
  await d.query(
    `update idempotency_keys
        set status = 'completed', response_code = $3, response_body = $4
      where scope = $1 and key = $2`,
    [scope, key, response.statusCode, JSON.stringify(response.body)],
  );
}

/** Releases a reservation so a failed request can be retried with the same key. */
export async function releaseIdempotent(d: Db, scope: string, key: string): Promise<void> {
  await d.query(
    `delete from idempotency_keys where scope = $1 and key = $2 and status = 'in_progress'`,
    [scope, key],
  );
}
