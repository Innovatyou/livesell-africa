import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Env } from '../config/env';
import { OrdersService } from './orders.service';

export const ORDERS_QUEUE = 'orders';
const EVERY_MS = 5 * 60_000;

/** Releases stock held by unpaid orders whose hold has expired (BullMQ job scheduler, idempotent work). */
@Injectable()
export class OrdersJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrdersJobs.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(private readonly config: ConfigService<Env, true>, private readonly orders: OrdersService) {}

  async onApplicationBootstrap() {
    if (!this.config.get('JOBS_ENABLED', { infer: true })) return;
    const url = this.config.get('REDIS_URL', { infer: true });
    const conn = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(ORDERS_QUEUE, { connection: conn() });
    await this.queue.upsertJobScheduler('expire-reservations', { every: EVERY_MS }, {
      name: 'expire-reservations', opts: { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 15_000 } },
    });
    this.worker = new Worker(ORDERS_QUEUE, async (job) => {
      if (job.name === 'expire-reservations') return this.orders.expireReservations(new Date());
      throw new Error(`Unknown orders job ${job.name}`);
    }, { connection: conn(), concurrency: 1 });
    this.worker.on('failed', (job, err) => this.logger.error(`Orders job ${job?.name} failed: ${err.message}`));
    this.logger.log(`Reservation expiry scheduled every ${EVERY_MS / 60_000} min`);
  }

  async onApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}
