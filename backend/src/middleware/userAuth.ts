import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; authUserId: string | null };
  }
}

interface JwtClaims {
  sub?: string;
  exp?: number;
  [k: string]: unknown;
}

/**
 * Verifies an HS256 JWT. Compatible with Supabase Auth access tokens — set
 * SESSION_JWT_SECRET to the project's JWT secret and the vault app's session
 * works here unchanged.
 */
export function verifyJwtHs256(token: string, secret: string, nowMs = Date.now()): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed session token.', 'invalid_token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Malformed session token.', 'invalid_token');
  }
  if (header.alg !== 'HS256') {
    throw unauthorized('Unsupported token algorithm.', 'invalid_token');
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = Buffer.from(signatureB64, 'base64url');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw unauthorized('Invalid session token signature.', 'invalid_token');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Malformed session token.', 'invalid_token');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= nowMs) {
    throw unauthorized('Session token expired.', 'token_expired');
  }
  if (!claims.sub) throw unauthorized('Session token has no subject.', 'invalid_token');

  return claims;
}

/** Resolves the caller to a row in `users`, creating one on first sight. */
export async function requireUser(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Sign in required.', 'unauthorized');

  const claims = verifyJwtHs256(header.slice(7).trim(), config().SESSION_JWT_SECRET);
  const authUserId = claims.sub as string;

  // users.auth_user_id is a uuid (it mirrors auth.users.id). A validly signed
  // token with a non-uuid subject is an auth misconfiguration, not a server
  // fault — reject it rather than letting Postgres raise a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authUserId)) {
    throw unauthorized('Session token subject must be a uuid.', 'invalid_token');
  }

  const email = typeof claims.email === 'string' ? claims.email : null;
  const phone = typeof claims.phone === 'string' && claims.phone ? claims.phone : null;

  const { rows } = await db.query<{ id: string; auth_user_id: string | null }>(
    `insert into users (auth_user_id, email, phone)
     values ($1, $2, $3)
     on conflict (auth_user_id) do update
       set email = coalesce(excluded.email, users.email),
           phone = coalesce(excluded.phone, users.phone)
     returning id, auth_user_id`,
    [authUserId, email, phone],
  );

  const row = rows[0];
  if (!row) throw unauthorized('Could not resolve user.', 'unauthorized');
  req.user = { id: row.id, authUserId: row.auth_user_id };
}

export function currentUser(req: FastifyRequest): { id: string } {
  if (!req.user) throw unauthorized('Sign in required.', 'unauthorized');
  return req.user;
}
