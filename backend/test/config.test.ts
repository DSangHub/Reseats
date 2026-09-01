import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgresql://localhost:5432/reseats',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  API_KEY_PEPPER: 'pepper',
  SESSION_JWT_SECRET: 'secret',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.MATCH_WINDOW_SECONDS).toBe(900);
    expect(cfg.CARD_PROVIDERS).toEqual(['mock']);
  });

  it('fails loudly when a required secret is missing', () => {
    const { API_KEY_PEPPER: _omit, ...withoutPepper } = base;
    expect(() => loadConfig(withoutPepper as NodeJS.ProcessEnv)).toThrow(/API_KEY_PEPPER/);
  });

  it('parses the provider list', () => {
    const cfg = loadConfig({ ...base, CARD_PROVIDERS: 'stripe, mock ' });
    expect(cfg.CARD_PROVIDERS).toEqual(['stripe', 'mock']);
  });

  it('parses booleans from strings', () => {
    expect(loadConfig({ ...base, DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(true);
    expect(loadConfig({ ...base, DATABASE_SSL: 'false' }).DATABASE_SSL).toBe(false);
    expect(loadConfig({ ...base, DATABASE_SSL: '' }).DATABASE_SSL).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...base, PORT: 'eight thousand' })).toThrow();
  });

  it('parses the CORS allowlist', () => {
    const cfg = loadConfig({ ...base, CORS_ORIGINS: 'https://reseats.org, https://www.reseats.org' });
    expect(cfg.CORS_ORIGINS).toEqual(['https://reseats.org', 'https://www.reseats.org']);
  });

  it('allows an empty CORS list outside production', () => {
    expect(loadConfig(base).CORS_ORIGINS).toEqual([]);
  });

  it('refuses to boot in production without a CORS allowlist', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
  });

  it('boots in production once origins are set', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://reseats.org',
    });
    expect(cfg.CORS_ORIGINS).toEqual(['https://reseats.org']);
  });
});
