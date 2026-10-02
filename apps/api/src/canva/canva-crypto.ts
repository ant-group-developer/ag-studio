import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Canva tokens at rest: AES-256-GCM under CANVA_TOKEN_KEY (32 bytes as 64 hex characters or base64), stored as
 * `v1.<iv>.<tag>.<ciphertext>` in base64url. A wrong key or a changed value fails to decrypt instead of misreading.
 */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    const key = /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, 'hex') : Buffer.from(secret, 'base64');
    if (key.length !== 32) throw new Error('CANVA_TOKEN_KEY must be 32 bytes (64 hex characters or base64)');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(sealed: string): string {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('not a sealed Canva token');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge, both base64url. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomState = (): string => randomBytes(32).toString('base64url');
