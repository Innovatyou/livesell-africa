import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { Env } from '../config/env';
import { tenantScopeExtension } from './tenant-scope.extension';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({ adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }) });
  }

  /**
   * Returns a client that automatically constrains every query on a tenant-owned model to `tenantId`.
   * Use this in all seller-facing services. The raw client is reserved for platform-admin and auth flows.
   */
  forTenant(tenantId: string) {
    return this.$extends(tenantScopeExtension(tenantId));
  }

  /**
   * Interactive transaction on the tenant-scoped client. The transaction keeps the tenant scope at runtime;
   * it is typed as a plain TransactionClient so shared helpers can accept either kind of transaction.
   */
  tenantTransaction<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.forTenant(tenantId).$transaction((tx) => fn(tx as unknown as Prisma.TransactionClient));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export type TenantPrisma = ReturnType<PrismaService['forTenant']>;
