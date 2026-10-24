import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const AAD = Buffer.from('ptoy.character-link.v1');
const key = (secret: string) => Buffer.from(hkdfSync('sha256', secret, '', AAD, 32));

/** Version byte + 12-byte nonce + 16-byte authentication tag + encrypted UTF-8 id. */
export function createCharacterLink(characterId: string, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(characterId, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function resolveCharacterLink(token: string, secret: string): string {
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < 30 || bytes[0] !== VERSION || bytes.toString('base64url') !== token) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(secret), bytes.subarray(1, 13));
    decipher.setAAD(AAD);
    decipher.setAuthTag(bytes.subarray(13, 29));
    return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('invalid character link');
  }
}
