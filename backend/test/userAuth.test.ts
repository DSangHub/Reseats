import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyJwtHs256 } from '../src/middleware/userAuth.js';

const SECRET = 'test-session-secret';

function makeToken(
  payload: Record<string, unknown>,
  { secret = SECRET, alg = 'HS256' }: { secret?: string; alg?: string } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const NOW = 1_800_000_000_000;

describe('verifyJwtHs256', () => {
  it('accepts a valid token', () => {
    const token = makeToken({ sub: 'auth-user-1', exp: NOW / 1000 + 3600 });
    expect(verifyJwtHs256(token, SECRET, NOW).sub).toBe('auth-user-1');
  });

  it('rejects a token signed with another secret', () => {
    const token = makeToken({ sub: 'x', exp: NOW / 1000 + 60 }, { secret: 'attacker' });
    expect(() => verifyJwtHs256(token, SECRET, NOW)).toThrow(/signature/i);
  });

  it('rejects an expired token', () => {
    const token = makeToken({ sub: 'x', exp: NOW / 1000 - 1 });
    expect(() => verifyJwtHs256(token, SECRET, NOW)).toThrow(/expired/i);
  });

  it('rejects the alg=none downgrade', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    expect(() => verifyJwtHs256(`${header}.${body}.`, SECRET, NOW)).toThrow(/algorithm/i);
  });

  it('rejects a token with a tampered payload', () => {
    const token = makeToken({ sub: 'user-a', exp: NOW / 1000 + 60 });
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'user-b', exp: NOW / 1000 + 60 })).toString(
      'base64url',
    );
    expect(() => verifyJwtHs256(`${h}.${forged}.${s}`, SECRET, NOW)).toThrow(/signature/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyJwtHs256('not.a.jwt.at.all', SECRET, NOW)).toThrow(/malformed/i);
    expect(() => verifyJwtHs256('abc', SECRET, NOW)).toThrow(/malformed/i);
  });

  it('rejects a token with no subject', () => {
    const token = makeToken({ exp: NOW / 1000 + 60 });
    expect(() => verifyJwtHs256(token, SECRET, NOW)).toThrow(/subject/i);
  });

  it('accepts a token with no exp claim', () => {
    expect(verifyJwtHs256(makeToken({ sub: 'x' }), SECRET, NOW).sub).toBe('x');
  });
});
