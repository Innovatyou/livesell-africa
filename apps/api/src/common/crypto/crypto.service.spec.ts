import { randomBytes } from 'node:crypto';
import { CryptoService } from './crypto.service';

const config = { get: (k: string) => ({ DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TOKEN_HASH_SECRET: 'x'.repeat(40) } as any)[k] };

describe('CryptoService', () => {
  const svc = new CryptoService(config as any);

  it('round-trips and uses a fresh IV each time', () => {
    const a = svc.encrypt('sk_live_secret');
    expect(a).not.toEqual(svc.encrypt('sk_live_secret'));
    expect(svc.decrypt(a)).toBe('sk_live_secret');
  });

  it('detects tampering', () => {
    const [v, iv, tag, ct] = svc.encrypt('0123456789').split('.');
    const flipped = Buffer.from(ct, 'base64url'); flipped[0] ^= 1;
    expect(() => svc.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('binds ciphertext to its tenant via AAD', () => {
    const enc = svc.encrypt('0123456789', 'tenant-a');
    expect(svc.decrypt(enc, 'tenant-a')).toBe('0123456789');
    expect(() => svc.decrypt(enc, 'tenant-b')).toThrow();
  });

  it('hashes tokens deterministically with a pepper', () => {
    const t = svc.randomToken();
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(svc.hashToken(t)).toBe(svc.hashToken(t));
    expect(svc.hashToken(t)).not.toContain(t);
  });
});
