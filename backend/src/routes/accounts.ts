import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, one } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { issueJwtHs256 } from '../middleware/userAuth.js';
const scrypt = promisify(scryptCallback);
const credentials = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(10).max(128), name: z.string().trim().min(1).max(100).optional() });
async function hash(password: string, salt: string): Promise<Buffer> { return await scrypt(password, salt, 64) as Buffer; }
function session(user: { auth_user_id: string; email: string }) { return { access_token: issueJwtHs256({ sub: user.auth_user_id, email: user.email }, config().SESSION_JWT_SECRET, 60 * 60 * 24 * 7), expires_in: 604800 }; }
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/account/signup', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_credentials', 'Enter a valid email and a password of 10–128 characters.');
    const { email, password, name } = parsed.data;
    const salt = randomBytes(16).toString('hex');
    const encoded = salt + ':' + (await hash(password, salt)).toString('hex');
    const user = await one<{ auth_user_id: string; email: string }>(db, `insert into users (auth_user_id,email,display_name,password_hash) values ($1,$2,$3,$4) on conflict (email) where email is not null do nothing returning auth_user_id,email`, [randomUUID(),email,name ?? null,encoded]);
    if (!user) throw conflict('account_exists', 'This email cannot be registered. Try signing in.');
    reply.code(201); return session(user);
  });
  app.post('/account/signin', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) throw unauthorized('Email or password is incorrect.');
    const user = await one<{ auth_user_id: string; email: string; password_hash: string | null }>(db, 'select auth_user_id,email,password_hash from users where email=$1', [parsed.data.email]);
    const [salt, encoded] = (user?.password_hash ?? '00000000000000000000000000000000:' + '00'.repeat(64)).split(':');
    const actual = await hash(parsed.data.password, salt!);
    const expected = Buffer.from(encoded!, 'hex');
    if (!user?.password_hash || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unauthorized('Email or password is incorrect.');
    return session(user);
  });
}
