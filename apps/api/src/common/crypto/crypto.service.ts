import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Env } from '../../config/env';

const VERSION = 'v1';

/**
 * Field-level encryption (AES-256-GCM) for secrets at rest: gateway keys, bank account numbers, MFA secrets.
 * Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>. Optional AAD binds ciphertext to its owner
 * (e.g. tenantId), so a value copied into another tenant's row fails to decrypt.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly tokenSecret: string;

  constructor(config: ConfigService<Env, true>) {
    this.key = Buffer.from(String(config.get('DATA_ENCRYPTION_KEY', { infer: true })), 'base64');
    this.tokenSecret = config.get('TOKEN_HASH_SECRET', { infer: true });
  }

  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string, aad?: string): string {
    const [version, iv, tag, ct] = payload.split('.');
    if (version !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Opaque high-entropy token for refresh / verification / invitations. Only its hash is stored. */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  hashToken(token: string): string {
    return createHmac('sha256', this.tokenSecret).update(token).digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
