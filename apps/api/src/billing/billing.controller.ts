import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowInactiveSubscription, CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { ChangePlanDto } from './plans.dto';
import { CommissionBillingService } from './commission-billing.service';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('billing')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@RequirePermissions('billing:manage')
@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(private readonly subs: SubscriptionsService, private readonly commission: CommissionBillingService) {}

  @AllowInactiveSubscription() @Get('commission')
  @ApiOperation({ summary: 'Commission rate, amount owed on directly collected sales, commission invoices and whether writes are blocked' })
  commissionSummary(@CurrentTenant() t: TenantContext) {
    return this.commission.summary(t.tenantId);
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Current subscription, plan, pending change, usage vs limits, open invoices' })
  overview(@CurrentTenant() t: TenantContext) {
    return this.subs.overview(t.tenantId);
  }

  @Get('invoices') @ApiOperation({ summary: 'Subscription invoices (latest 100)' })
  invoices(@CurrentTenant() t: TenantContext) {
    return this.subs.invoices(t.tenantId);
  }

  @Get('history') @ApiOperation({ summary: 'Subscription history (latest 100 events)' })
  history(@CurrentTenant() t: TenantContext) {
    return this.subs.history(t.tenantId);
  }

  @AllowInactiveSubscription() @Post('subscription/change') @HttpCode(200)
  @ApiOperation({ summary: 'Change plan / interval. Trial: immediate. Upgrade: prorated invoice. Downgrade: at period end' })
  change(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ChangePlanDto) {
    return this.subs.changePlan(t.tenantId, u.id, dto.planCode, dto.interval);
  }

  @AllowInactiveSubscription() @Post('subscription/cancel-pending-change') @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a scheduled downgrade / interval change' })
  cancelPending(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.subs.cancelPendingChange(t.tenantId, u.id);
  }

  @Post('subscription/cancel') @HttpCode(200)
  @ApiOperation({ summary: 'Cancel at the end of the trial / current period' })
  cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.subs.scheduleCancel(t.tenantId, u.id);
  }

  @Post('subscription/resume') @HttpCode(200)
  @ApiOperation({ summary: 'Undo a scheduled cancellation' })
  resume(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.subs.resume(t.tenantId, u.id);
  }
}
