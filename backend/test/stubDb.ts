import type { Db } from '../src/db/index.js';

export interface RecordedQuery {
  text: string;
  params: readonly unknown[];
}

type Responder = (text: string, params: readonly unknown[]) => unknown[] | undefined;

/**
 * A Db that answers from a list of matcher functions and records everything it
 * was asked. Lets the service layer be tested without a live Postgres.
 */
export function stubDb(responders: Responder[] = []): Db & { calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  return {
    calls,
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });
      for (const r of responders) {
        const rows = r(text, params);
        if (rows !== undefined) return { rows: rows as never, rowCount: rows.length };
      }
      return { rows: [] as never, rowCount: 0 };
    },
  };
}

export const when = (fragment: string, rows: unknown[]): Responder =>
  (text) => (text.includes(fragment) ? rows : undefined);
