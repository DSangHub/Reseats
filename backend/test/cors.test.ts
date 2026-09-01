import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/app.js';

const allowed = [
  'https://reseats.org',
  'https://www.reseats.org',
  'https://*.vercel.app',
];

describe('CORS origin matching', () => {
  it('accepts the production sites and Vercel preview subdomains', () => {
    expect(isAllowedOrigin('https://reseats.org', allowed)).toBe(true);
    expect(isAllowedOrigin('https://reseats-git-main-example.vercel.app', allowed)).toBe(true);
  });

  it('rejects insecure and look-alike origins', () => {
    expect(isAllowedOrigin('http://reseats.vercel.app', allowed)).toBe(false);
    expect(isAllowedOrigin('https://vercel.app.attacker.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://reseats.org.attacker.example', allowed)).toBe(false);
  });

  it('allows requests without a browser Origin header', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });
});
