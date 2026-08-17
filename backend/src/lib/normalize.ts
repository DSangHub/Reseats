/**
 * Card statement descriptors are noisy: "SQ *MARIO'S TRATTORIA  #0847",
 * "TST* MARIOS TRAT", "MARIOS TRATTORIA 4155551212 CA".
 *
 * We reduce them to a comparable core so a card transaction can be tied back to
 * the merchant that pushed the POS receipt.
 */

/** Aggregator/gateway prefixes that carry no merchant identity. */
const AGGREGATOR_PREFIXES = [
  'sq *',
  'sq*',
  'tst*',
  'tst* ',
  'py *',
  'py*',
  'sp *',
  'sp*',
  'clv*',
  'clover ',
  'toast*',
  'paypal *',
  'pp*',
  'stripe *',
  'shopify *',
  'wl *',
  'ec*',
];

/** Trailing noise commonly appended by acquirers. */
const NOISE_TOKENS = new Set([
  'inc',
  'llc',
  'ltd',
  'co',
  'corp',
  'the',
  'usa',
  'us',
  'online',
  'store',
  'pos',
]);

export function normalizeDescriptor(raw: string): string {
  let s = (raw ?? '').toLowerCase().trim();

  for (const prefix of AGGREGATOR_PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }

  s = s
    // drop apostrophes outright so "mario's" collapses to "marios" rather than
    // splitting into two tokens
    .replace(/['’ʼ]/g, '')
    // strip URLs and emails
    .replace(/\b(?:https?:\/\/)?[a-z0-9-]+\.(?:com|net|org|io|co)\b/g, ' ')
    // strip phone numbers
    .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
    // strip reference/order numbers
    .replace(/#\s?\d+/g, ' ')
    // punctuation to space
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    // drop bare numbers and 2-letter state codes at the tail
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !NOISE_TOKENS.has(t));

  return tokens.join(' ').trim();
}

/**
 * Cheap similarity for descriptor comparison: token overlap weighted toward
 * the shorter string, so "marios trattoria" vs "marios trat" scores well.
 * Returns 0..1. Postgres trigram matching does the heavy lifting in SQL; this
 * is the in-process tiebreaker when several candidates come back.
 */
export function descriptorSimilarity(a: string, b: string): number {
  const at = new Set(a.split(' ').filter(Boolean));
  const bt = new Set(b.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;

  let hits = 0;
  for (const t of at) {
    if (bt.has(t)) {
      hits += 1;
      continue;
    }
    // prefix match handles truncated descriptors ("trat" vs "trattoria")
    for (const u of bt) {
      const short = t.length <= u.length ? t : u;
      const long = t.length <= u.length ? u : t;
      if (short.length >= 4 && long.startsWith(short)) {
        hits += 0.8;
        break;
      }
    }
  }
  return Math.min(1, hits / Math.min(at.size, bt.size));
}
