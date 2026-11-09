import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import type { AccessTokenClaims, AuthUser } from '../common/auth/request-context';
import { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface ClientMeta { ip?: string; userAgent?: string }
export interface TokenPair { accessToken: string; accessTokenExpiresIn: number; refreshToken: string; refreshExpiresAt: Date; sessionId: string }

/**
 * Refresh-token rotation with reuse detection (OAuth 2.0 Security BCP §4.14):
 * every refresh issues a new token in the same family and revokes the old one.
 * Presenting a revoked token means it was stolen or replayed → the whole family is revoked.
 */
@Injectable()
export class TokenService {
  private readonly accessTtl: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.accessTtl = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtlMs = config.get('REFRESH_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  async issue(user: AuthUser, meta: ClientMeta, familyId: string = randomUUID()): Promise<TokenPair> {
    const claims: AccessTokenClaims = { sub: user.id, email: user.email, pr: user.platformRole, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims, { expiresIn: this.accessTtl, algorithm: 'HS256' });
    const refreshToken = this.crypto.randomToken(32);
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlMs);
    const row = await this.prisma.refreshToken.create({
      data: {
        userId: user.id, familyId, tokenHash: this.crypto.hashToken(refreshToken), expiresAt: refreshExpiresAt,
        ip: meta.ip, userAgent: meta.userAgent?.slice(0, 512),
      },
    });
    return { accessToken, accessTokenExpiresIn: this.accessTtl, refreshToken, refreshExpiresAt, sessionId: row.id };
  }

  async rotate(presented: string, meta: ClientMeta): Promise<TokenPair> {
    const tokenHash = this.crypto.hashToken(presented);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, platformRole: true, status: true } } },
    });
    if (!existing) throw new UnauthorizedException('Invalid refresh token');

    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId);
      await this.audit.record({
        action: 'auth.refresh_reuse_detected', actorId: existing.userId,
        metadata: { familyId: existing.familyId }, ip: meta.ip, userAgent: meta.userAgent,
      });
      throw new UnauthorizedException('Refresh token reuse detected; please sign in again');
    }
    if (existing.expiresAt <= new Date() || existing.user.status === 'SUSPENDED') {
      throw new UnauthorizedException('Session expired');
    }

    // Atomic claim: only one concurrent request can consume a given token.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Refresh token reuse detected; please sign in again');
    }

    const { user } = existing;
    const pair = await this.issue({ id: user.id, email: user.email, platformRole: user.platformRole }, meta, existing.familyId);
    await this.prisma.refreshToken.update({ where: { id: existing.id }, data: { replacedBy: pair.sessionId } });
    return pair;
  }

  /** Revokes the session the presented token belongs to. Unknown tokens are ignored (idempotent logout). */
  async revokeByToken(presented: string): Promise<string | null> {
    const t = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.crypto.hashToken(presented) } });
    if (!t) return null;
    await this.revokeFamily(t.familyId);
    return t.userId;
  }

  async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string) {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
