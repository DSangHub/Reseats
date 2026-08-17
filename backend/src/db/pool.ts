import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// bigint (OID 20) arrives as a string by default. Every money column in this
// schema is cents in a bigint, and cents comfortably fit in a JS number below
// Number.MAX_SAFE_INTEGER, so parse it — but refuse to silently lose precision.
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint ${v} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return n;
});
// numeric (OID 1700) — used only for line-item quantities.
types.setTypeParser(1700, (v: string) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const c = config();
    pool = new Pool({
      connectionString: c.DATABASE_URL,
      max: c.DATABASE_POOL_MAX,
      ssl: c.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      application_name: 'reseats-api',
    });
  }
  return pool;
}

export function setPool(p: Pool | null): void {
  pool = p;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
