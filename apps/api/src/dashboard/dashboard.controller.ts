import { Controller, Get, ParseEnumPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, RequirePermissions } from '../common/auth/decorators';
import type { TenantContext } from '../common/auth/request-context';
import { ChartPeriod, DashboardService } from './dashboard.service';

const PERIODS = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' } as const;

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@RequirePermissions('reports:read')
@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'KPIs, top products, recent customers and transactions (real data; money as kobo strings)' })
  summary(@CurrentTenant() t: TenantContext) {
    return this.dashboard.summary(t.tenantId);
  }

  @Get('sales')
  @ApiOperation({ summary: 'Verified sales per day (30), week (12), month (12) or year (5), zero-filled' })
  @ApiQuery({ name: 'period', enum: Object.keys(PERIODS), required: false })
  sales(@CurrentTenant() t: TenantContext, @Query('period', new ParseEnumPipe(PERIODS, { optional: true })) period?: ChartPeriod) {
    return this.dashboard.salesChart(t.tenantId, period ?? 'daily');
  }
}
