import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AutomationModule } from './automation/automation.module';
import { LogisticsModule } from './logistics/logistics.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { PushModule } from './push/push.module';
import { BillingModule } from './billing/billing.module';
import { CatalogModule } from './catalog/catalog.module';
import { JwtAuthGuard, PermissionsGuard, PlatformRoleGuard, SubscriptionGuard, TenantGuard } from './common/auth/guards';
import { CommonModule } from './common/common.module';
import { Env, validateEnv } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { LiveModule } from './live/live.module';
import { OrdersModule } from './orders/orders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SalesModule } from './sales/sales.module';
import { StaffModule } from './staff/staff.module';
import { StorageModule } from './storage/storage.module';
import { StorefrontModule } from './storefront/storefront.module';
import { TenantsController } from './tenants/tenants.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService<Env, true>) => [{ ttl: c.get('THROTTLE_TTL_MS', { infer: true }), limit: c.get('THROTTLE_LIMIT', { infer: true }) }],
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (c: ConfigService<Env, true>) => ({
        secret: c.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { issuer: 'livesell.africa', audience: 'livesell-api' },
        verifyOptions: { issuer: 'livesell.africa', audience: 'livesell-api' },
      }),
    }),
    PrismaModule,
    RedisModule,
    CommonModule,
    NotificationsModule,
    StorageModule,
    AuthModule,
    BillingModule,
    StaffModule,
    OnboardingModule,
    DashboardModule,
    SalesModule,
    InventoryModule,
    CatalogModule,
    CustomersModule,
    OrdersModule,
    LiveModule,
    PaymentsModule,
    AutomationModule,
    LogisticsModule,
    AnalyticsModule,
    AdminModule,
    PushModule,
    // After OnboardingModule: its /store/profile and /store/logo routes must win over the public /store/:slug.
    StorefrontModule,
  ],
  controllers: [HealthController, TenantsController],
  providers: [
    // Order matters: rate limit → authenticate → platform role → tenant membership → permission → subscription.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PlatformRoleGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
  ],
})
export class AppModule {}
