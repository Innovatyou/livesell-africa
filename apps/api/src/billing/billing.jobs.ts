import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { CommissionBillingService } from './commission-billing.service';
import { SubscriptionsService } from './subscriptions.service';

export const BILLING_QUEUE = 'billing';
export const LIFECYCLE_SCHEDULER = 'subscription-lifecycle';
const EVERY_MS = 15 * 60_000;

/**
 * Registers the subscription lifecycle (trial end, renewal, expiry, reminders) as a BullMQ job scheduler.
 * `upsertJobScheduler` is idempotent, so every API instance can call it on boot; BullMQ runs each tick once.
 * The work itself is idempotent too (guarded state transitions + reminder dedupe keys).
 */
@Injectable()
export class BillingJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BillingJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly subs: SubscriptionsService, private readonly commission: CommissionBillingService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    // BullMQ workers need blocking connections without a per-request retry cap.
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(BILLING_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler(LIFECYCLE_SCHEDULER, { every: EVERY_MS }, {
      name: 'lifecycle', opts: { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    });
    await this.queue.upsertJobScheduler('commission-invoices', { every: 60 * 60_000 }, {
      name: 'commission-invoices', opts: { removeOnComplete: 50, removeOnFail: 200, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
    });
    this.worker = new Worker(BILLING_QUEUE, async (job) => {
      if (job.name === 'lifecycle') return this.subs.runLifecycle(new Date());
      if (job.name === 'commission-invoices') return this.commission.issueDue(new Date());
      throw new Error(`Unknown billing job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Billing job ${job?.name} failed: ${err.message}`));
    this.logger.log(`Billing lifecycle scheduled every ${EVERY_MS / 60_000} min`);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
