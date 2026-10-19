import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../src/db/index.js', () => ({ db: {}, one: async (_db: unknown, sql: string, values: unknown[]) => {
  if (sql.startsWith('insert')) { if (rows.has(values[1] as string)) return null; const user = { auth_user_id: values[0], email: values[1], password_hash: values[3] }; rows.set(values[1] as string,user); return user; }
  return rows.get(values[0] as string) ?? null;
} }));
vi.mock('../src/config.js', () => ({ config: () => ({ SESSION_JWT_SECRET: 'account-test-secret' }) }));
import { accountRoutes } from '../src/routes/accounts.js';
it('creates a recoverable account, rejects wrong passwords and duplicate signup', async () => {
 const app=Fastify(); app.setErrorHandler((err, _req, reply) => reply.code((err as {statusCode?:number}).statusCode ?? 500).send({message:err.message})); await app.register(accountRoutes);
 const payload={email:'test@example.com',password:'correct-password-123',name:'Test'};
 const created=await app.inject({method:'POST',url:'/account/signup',payload}); expect(created.statusCode).toBe(201); expect(created.json().access_token).toBeTruthy(); expect(rows.get(payload.email)?.password_hash).not.toContain(payload.password);
 expect((await app.inject({method:'POST',url:'/account/signin',payload:{...payload,password:'wrong-password-123'}})).statusCode).toBe(401);
 expect((await app.inject({method:'POST',url:'/account/signin',payload})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:'/account/signup',payload})).statusCode).toBe(409);
 await app.close();
});
