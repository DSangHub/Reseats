import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { hashApiKey } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { MerchantAuth, MerchantRow } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    merchant?: MerchantAuth;
  }
}

function extractKey(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-reseats-key'];
  if (typeof alt === 'string' && alt.length > 0) return alt.trim();
  return null;
}

/**
 * Authenticates a POS request with a merchant API key.
 *
 * The key is never compared in the database as plaintext — we look it up by its
 * peppered HMAC, which is also the unique index, so this is a single index hit.
 */
export async function requireMerchant(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const secret = extractKey(req);
  if (!secret) throw unauthorized();

  const hash = hashApiKey(secret, config().API_KEY_PEPPER);

  const { rows } = await db.query<{
    api_key_id: string;
    mode: 'live' | 'test';
    scopes: string[];
    merchant_id: string;
    name: string;
    slug: string;
    status: MerchantRow['status'];
    display_name: string | null;
    timezone: string;
  }>(
    `select k.id  as api_key_id,
            k.mode, k.scopes,
            m.id   as merchant_id,
            m.name, m.slug, m.status, m.display_name, m.timezone
       from merchant_api_keys k
       join merchants m on m.id = k.merchant_id
      where k.key_hash = $1 and k.revoked_at is null`,
    [hash],
  );

  const row = rows[0];
  if (!row) throw unauthorized();

  if (row.status === 'suspended') {
    throw forbidden('This merchant account is suspended.', 'merchant_suspended');
  }

  req.merchant = {
    merchant: {
      id: row.merchant_id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      display_name: row.display_name,
      timezone: row.timezone,
    },
    apiKeyId: row.api_key_id,
    mode: row.mode,
    scopes: row.scopes,
  };

  // Best-effort last-used stamp; never block the request on it.
  void db
    .query(`update merchant_api_keys set last_used_at = now() where id = $1`, [row.api_key_id])
    .catch(() => undefined);
}

export function requireScope(scope: string) {
  return async (req: FastifyRequest): Promise<void> => {
    const auth = req.merchant;
    if (!auth) throw unauthorized();
    if (!auth.scopes.includes(scope) && !auth.scopes.includes('*')) {
      throw forbidden(`This API key is missing the "${scope}" scope.`, 'insufficient_scope');
    }
  };
}

export function merchantAuth(req: FastifyRequest): MerchantAuth {
  if (!req.merchant) throw unauthorized();
  return req.merchant;
}
