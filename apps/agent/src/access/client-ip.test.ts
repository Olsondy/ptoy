import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientIp } from './client-ip.js';
const request = (remoteAddress: string, forwarded?: string) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } }) as unknown as IncomingMessage;
describe('trusted reverse proxy IP boundary', () => {
  it('ignores spoofed headers from an untrusted socket', () => { expect(clientIp(request('203.0.113.1', '1.2.3.4'), [])).toBe('203.0.113.1'); });
  it('uses the nearest untrusted hop rather than the client-supplied first value', () => {
    expect(clientIp(request('::ffff:127.0.0.1', '1.2.3.4, 203.0.113.5, 127.0.0.2'), ['127.0.0.1', '127.0.0.2'])).toBe('203.0.113.5');
  });
  it('falls back to the socket for malformed or all-trusted chains', () => {
    expect(clientIp(request('127.0.0.1', 'invalid'), ['127.0.0.1'])).toBe('127.0.0.1');
    expect(clientIp(request('127.0.0.1', '127.0.0.1'), ['127.0.0.1'])).toBe('127.0.0.1');
  });
});
