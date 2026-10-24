import { describe, expect, it } from 'vitest';
import { createCharacterLink, resolveCharacterLink } from './character-link.js';

describe('encrypted character links', () => {
  const secret = 'test-only-secret';
  it('round trips a Unicode id through a URL-safe, randomized token', () => {
    const first = createCharacterLink('角色-a', secret);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolveCharacterLink(first, secret)).toBe('角色-a');
    expect(createCharacterLink('角色-a', secret)).not.toBe(first);
  });

  it('rejects tampering, another key, invalid versions and malformed tokens', () => {
    const token = createCharacterLink('a', secret);
    const tampered = Buffer.from(token, 'base64url');
    tampered[15] = tampered[15]! ^ 1;
    const wrongVersion = Buffer.from(token, 'base64url');
    wrongVersion[0] = 2;
    for (const invalid of ['', 'abc', token + '=', '!'.repeat(60), 'a'.repeat(2049), tampered.toString('base64url'), wrongVersion.toString('base64url')]) {
      expect(() => resolveCharacterLink(invalid, secret)).toThrow('invalid character link');
    }
    expect(() => resolveCharacterLink(token, 'another-secret')).toThrow('invalid character link');
  });
});
