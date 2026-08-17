import type { PoolClient } from './pool.js';
import { getPool } from './pool.js';

/**
 * Minimal query surface. Everything in services/ takes a `Db` so the same code
 * runs against the pool or inside a transaction — no hidden ambient client.
 */
export interface Db {
  query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}

export const db: Db = {
  async query(text, params) {
    const res = await getPool().query(text, params as unknown[]);
    return { rows: res.rows as never, rowCount: res.rowCount ?? 0 };
  },
};

export async function withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('begin');
    const tx: Db = {
      async query(text, params) {
        const res = await client.query(text, params as unknown[]);
        return { rows: res.rows as never, rowCount: res.rowCount ?? 0 };
      },
    };
    const result = await fn(tx);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already broken; pool will discard it */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends object>(
  d: Db,
  text: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const { rows } = await d.query<T>(text, params);
  return rows[0] ?? null;
}

export async function many<T extends object>(
  d: Db,
  text: string,
  params?: readonly unknown[],
): Promise<T[]> {
  const { rows } = await d.query<T>(text, params);
  return rows;
}
