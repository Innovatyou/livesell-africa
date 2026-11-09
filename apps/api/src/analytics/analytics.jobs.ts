import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { ReportSchedulesService } from './report-schedules.service';

export const ANALYTICS_QUEUE = 'analytics';

/** Sends scheduled analytics emails (hourly check; idempotent per period and person). */
@Injectable()
export class AnalyticsJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AnalyticsJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly schedules: ReportSchedulesService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(ANALYTICS_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler('report-schedules', { every: 60 * 60_000 }, { name: 'report-schedules', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    this.worker = new Worker(ANALYTICS_QUEUE, async (job) => {
      if (job.name === 'report-schedules') return this.schedules.runDue(new Date());
      throw new Error(`Unknown analytics job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Analytics job ${job?.name} failed: ${err.message}`));
    this.logger.log('Scheduled analytics reports checked hourly');
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
