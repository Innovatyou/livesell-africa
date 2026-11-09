import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../config/env';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [{
    provide: REDIS,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) =>
      new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: false }),
  }],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
