import { describe, expect, it } from 'vitest';
import { descriptorSimilarity, normalizeDescriptor } from '../src/lib/normalize.js';

describe('normalizeDescriptor', () => {
  it.each([
    ["SQ *MARIO'S TRATTORIA", 'marios trattoria'],
    ['TST* MARIOS TRAT', 'marios trat'],
    ['MARIOS TRATTORIA 4155551212 CA', 'marios trattoria ca'],
    ['GREEN LEAF GROCERS #0847', 'green leaf grocers'],
    ['NORTHSIDE ELECTRONICS INC', 'northside electronics'],
    ['PAYPAL *NORTHSIDE ELEC', 'northside elec'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDescriptor(input)).toBe(expected);
  });

  it('handles empty and junk input without throwing', () => {
    expect(normalizeDescriptor('')).toBe('');
    expect(normalizeDescriptor('###')).toBe('');
  });
});

describe('descriptorSimilarity', () => {
  it('scores an exact normalized match at 1', () => {
    expect(descriptorSimilarity('marios trattoria', 'marios trattoria')).toBe(1);
  });

  it('scores a truncated descriptor highly', () => {
    expect(descriptorSimilarity('marios trattoria', 'marios trat')).toBeGreaterThan(0.85);
  });

  it('scores unrelated merchants low', () => {
    expect(descriptorSimilarity('marios trattoria', 'green leaf grocers')).toBeLessThan(0.2);
  });

  it('returns 0 when either side is empty', () => {
    expect(descriptorSimilarity('', 'marios')).toBe(0);
  });
});
