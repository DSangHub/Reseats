/**
 * Applies SQL files in supabase/migrations in lexical order, once each.
 *
 * Useful for plain Postgres and CI. On Supabase you can equally run
 * `supabase db push` — the files are the same.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '../src/db/pool.js';

/**
 * Walk up from this file looking for supabase/migrations. Run via tsx this
 * script sits in scripts/; compiled it sits in dist/scripts/ — and the SQL is
 * not copied into dist. Searching upward covers both without a magic ../.. .
 */
function findMigrationsDir(start: string): string {
  let dir = start;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    if (dir === root) break;
    dir = dirname(dir);
  }
  throw new Error(
    `Could not find supabase/migrations searching upward from ${start}. ` +
      'Run this from the backend directory.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = findMigrationsDir(here);

async function main(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ filename: string }>('select filename from schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file}`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`apply  ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`failed ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
