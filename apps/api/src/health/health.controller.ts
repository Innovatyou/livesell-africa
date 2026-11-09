import { Controller, Get, Inject, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { Public } from '../common/auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly prisma: PrismaService, @Inject(REDIS) private readonly redis: Redis) {}

  /** Liveness: process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Used by Docker / load balancer. */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};
    await withTimeout(this.prisma.$queryRaw`SELECT 1`, 2000).then(() => (checks.database = 'up'), () => (checks.database = 'down'));
    await withTimeout(this.redis.ping(), 2000).then(() => (checks.redis = 'up'), () => (checks.redis = 'down'));
    if (Object.values(checks).includes('down')) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }
}
