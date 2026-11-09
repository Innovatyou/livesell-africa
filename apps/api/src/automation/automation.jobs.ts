import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { PushService } from '../push/push.service';
import { OrderNotifier } from './order-notifier.service';

export const AUTOMATION_QUEUE = 'automation';

/** Turns order events into customer messages (every 15 s) and sends timed reminders (every 10 minutes). Idempotent work. */
@Injectable()
export class AutomationJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AutomationJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly notifier: OrderNotifier, private readonly push: PushService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(AUTOMATION_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler('outbox', { every: 15_000 }, { name: 'outbox', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    await this.queue.upsertJobScheduler('push-receipts', { every: 15 * 60_000 }, { name: 'push-receipts', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    await this.queue.upsertJobScheduler('reminders', { every: 10 * 60_000 }, { name: 'reminders', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    this.worker = new Worker(AUTOMATION_QUEUE, async (job) => {
      if (job.name === 'outbox') return this.notifier.dispatchOutbox();
      if (job.name === 'reminders') return this.notifier.runReminders(new Date());
      if (job.name === 'push-receipts') return this.push.checkReceipts(new Date());
      throw new Error(`Unknown automation job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Automation job ${job?.name} failed: ${err.message}`));
    this.logger.log('Order message outbox and reminders scheduled');
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
