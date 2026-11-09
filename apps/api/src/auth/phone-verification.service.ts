import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { randomInt } from 'node:crypto';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';
import { AuthMailer } from './auth-mailer';
import type { ClientMeta } from './token.service';

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_S = 60;
export const OTP_MAX_PER_HOUR = 5;

/**
 * Phone verification by 6-digit SMS code. A 6-digit code is guessable, so: 5 attempts per code, 10-minute
 * expiry, 60-second resend cooldown and 5 codes per hour per user. Codes are stored only as salted HMACs.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly mailer: AuthMailer,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async sendCode(userId: string, newPhone: string | undefined, meta: ClientMeta) {
    if (!this.mailer.canSendSms) {
      throw new ServiceUnavailableException('SMS delivery is not available yet. Phone verification will open soon.');
    }
    let user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (newPhone && newPhone !== user.phone) {
      try {
        user = await this.prisma.user.update({ where: { id: userId }, data: { phone: newPhone, phoneVerifiedAt: null } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('That phone number is already used by another account');
        }
        throw e;
      }
      await this.audit.record({ action: 'auth.phone_changed', actorId: userId, ip: meta.ip, userAgent: meta.userAgent });
    }
    if (!user.phone) throw new BadRequestException('Add a phone number first');
    if (user.phoneVerifiedAt) return { status: 'already_verified' as const, phone: mask(user.phone) };

    await this.enforceRateLimits(userId);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.$transaction([
      this.prisma.verificationToken.updateMany({
        where: { userId, purpose: 'PHONE_VERIFY', consumedAt: null }, data: { consumedAt: new Date() },
      }),
      this.prisma.verificationToken.create({
        data: { userId, purpose: 'PHONE_VERIFY', tokenHash: this.hashCode(userId, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
      }),
    ]);
    await this.mailer.sendPhoneOtp(user.phone, code);
    await this.audit.record({ action: 'auth.phone_otp_sent', actorId: userId, ip: meta.ip, userAgent: meta.userAgent });
    return { status: 'sent' as const, phone: mask(user.phone), expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_COOLDOWN_S };
  }

  async verifyCode(userId: string, code: string, meta: ClientMeta) {
    const token = await this.prisma.verificationToken.findFirst({
      where: { userId, purpose: 'PHONE_VERIFY', consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) throw new BadRequestException('This code has expired. Request a new one.');
    if (token.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.verificationToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } });
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }

    if (!this.matches(token.tokenHash, userId, code)) {
      // Atomic increment guarded by the attempt cap, so parallel guesses can't exceed it.
      await this.prisma.verificationToken.updateMany({
        where: { id: token.id, attempts: { lt: OTP_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } },
      });
      await this.audit.record({ action: 'auth.phone_otp_failed', actorId: userId, ip: meta.ip, userAgent: meta.userAgent });
      const left = Math.max(0, OTP_MAX_ATTEMPTS - token.attempts - 1);
      throw new BadRequestException(left ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.');
    }

    const claimed = await this.prisma.verificationToken.updateMany({
      where: { id: token.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } }, data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException('This code has expired. Request a new one.');
    await this.prisma.user.update({ where: { id: userId }, data: { phoneVerifiedAt: new Date() } });
    await this.audit.record({ action: 'auth.phone_verified', actorId: userId, ip: meta.ip, userAgent: meta.userAgent });
    return { status: 'verified' as const };
  }

  private async enforceRateLimits(userId: string) {
    const cooldown = await this.redis.set(`otp:cooldown:${userId}`, '1', 'EX', OTP_RESEND_COOLDOWN_S, 'NX');
    if (cooldown !== 'OK') {
      const ttl = await this.redis.ttl(`otp:cooldown:${userId}`);
      throw new HttpException(`Please wait ${Math.max(ttl, 1)} seconds before requesting another code`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const hourKey = `otp:hour:${userId}`;
    const count = await this.redis.incr(hourKey);
    if (count === 1) await this.redis.expire(hourKey, 3600);
    if (count > OTP_MAX_PER_HOUR) {
      throw new HttpException('Too many codes requested. Try again in an hour.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** `<salt>:<hmac>` — the per-code salt keeps the unique token_hash column collision-free for 6-digit codes. */
  private hashCode(userId: string, code: string, salt = this.crypto.randomToken(12)) {
    return `${salt}:${this.crypto.hashToken(`phone-otp:${userId}:${salt}:${code}`)}`;
  }

  private matches(stored: string, userId: string, code: string) {
    const [salt] = stored.split(':');
    return !!salt && this.crypto.safeEqual(stored, this.hashCode(userId, code, salt));
  }
}

function mask(phone: string) {
  return phone.length > 6 ? `${phone.slice(0, 4)}${'•'.repeat(phone.length - 7)}${phone.slice(-3)}` : phone;
}
