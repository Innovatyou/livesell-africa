import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';

export const PAYMENTS_QUEUE = 'payments';
const EVERY_MS = 10 * 60_000;

/** Reconciles open payments and processing refunds with the provider (BullMQ job scheduler, idempotent work). */
@Injectable()
export class PaymentsJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly payments: PaymentsService, private readonly recon: ReconciliationService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(PAYMENTS_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler('reconcile', { every: EVERY_MS }, {
      name: 'reconcile', opts: { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 15_000 } },
    });
    // Daily ledger/transfer reconciliation report (02:30 Africa/Lagos).
    await this.queue.upsertJobScheduler('reconciliation-report', { pattern: '30 2 * * *', tz: 'Africa/Lagos' }, {
      name: 'reconciliation-report', opts: { removeOnComplete: 30, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 60_000 } },
    });
    this.worker = new Worker(PAYMENTS_QUEUE, async (job) => {
      if (job.name === 'reconcile') return this.payments.reconcile(new Date());
      if (job.name === 'reconciliation-report') return this.recon.runDaily(new Date());
      throw new Error(`Unknown payments job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Payments job ${job?.name} failed: ${err.message}`));
    this.logger.log(`Payment reconciliation scheduled every ${EVERY_MS / 60_000} min`);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
