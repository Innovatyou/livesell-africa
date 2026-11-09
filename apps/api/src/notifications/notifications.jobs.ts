import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { NotificationService } from './notifications.service';

export const NOTIFICATIONS_QUEUE = 'notifications';

/** Retries queued messages (every minute) and fetches SMS delivery receipts (every 10 minutes). Idempotent work. */
@Injectable()
export class NotificationsJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly notifications: NotificationService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler('retry-due', { every: 60_000 }, { name: 'retry-due', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    await this.queue.upsertJobScheduler('delivery-receipts', { every: 10 * 60_000 }, { name: 'delivery-receipts', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    this.worker = new Worker(NOTIFICATIONS_QUEUE, async (job) => {
      if (job.name === 'retry-due') return this.notifications.retryDue(new Date());
      if (job.name === 'delivery-receipts') return this.notifications.syncDelivery(new Date());
      throw new Error(`Unknown notifications job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Notifications job ${job?.name} failed: ${err.message}`));
    this.logger.log('Notification retries and delivery receipts scheduled');
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
