/**
 * Provisions a merchant and prints an API key.
 *
 *   npx tsx scripts/create-merchant.ts "Mario's Trattoria" \
 *     --descriptor "MARIOS TRATTORIA" --descriptor "TST* MARIOS TRAT"
 *
 * The secret is printed once and never recoverable — only its HMAC is stored.
 */
import { config } from '../src/config.js';
import { closePool, getPool } from '../src/db/pool.js';
import { generateApiKey } from '../src/lib/crypto.js';
import { normalizeDescriptor } from '../src/lib/normalize.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('Usage: tsx scripts/create-merchant.ts "<name>" [--descriptor "<text>"]...');
    process.exit(1);
  }

  const descriptors: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--descriptor' && args[i + 1]) descriptors.push(args[i + 1]!);
  }
  if (descriptors.length === 0) descriptors.push(name);

  const mode = args.includes('--test') ? 'test' : 'live';
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('begin');

    const merchant = await client.query<{ id: string }>(
      `insert into merchants (name, slug, status)
       values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name, status = 'active'
       returning id`,
      [name, slugify(name)],
    );
    const merchantId = merchant.rows[0]!.id;

    for (const d of descriptors) {
      await client.query(
        `insert into merchant_descriptors (merchant_id, descriptor, normalized)
         values ($1, $2, $3)
         on conflict (merchant_id, normalized) do nothing`,
        [merchantId, d, normalizeDescriptor(d)],
      );
    }

    const key = generateApiKey(config().API_KEY_PEPPER, mode);
    await client.query(
      `insert into merchant_api_keys (merchant_id, name, key_prefix, key_hash, mode)
       values ($1, 'default', $2, $3, $4)`,
      [merchantId, key.prefix, key.hash, mode],
    );

    await client.query('commit');

    console.log(`merchant_id: ${merchantId}`);
    console.log(`api_key    : ${key.secret}`);
    console.log('\nStore the key now — it is not recoverable.');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
