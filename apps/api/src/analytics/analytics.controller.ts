import { Body, Controller, ForbiddenException, Get, Header, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AuditService } from '../common/audit/audit.service';
import { CurrentTenant, CurrentUser, RequirePermissions } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { ADVANCED_CSV, CSV_REPORTS, CsvReport, reportCsv, reportPdf } from './analytics-export';
import { AnalyticsService } from './analytics.service';
import { ReportSchedulesService } from './report-schedules.service';

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'First day (Africa/Lagos), default 30 days ago' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional({ example: '2026-10-31', description: 'Last day (inclusive), default today' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @ApiPropertyOptional({ description: 'Only this sales channel' }) @IsOptional() @IsUUID() channelId?: string;
}

export class AnalyticsExportDto extends AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: CSV_REPORTS, default: 'summary' }) @IsOptional() @IsIn(CSV_REPORTS) report?: CsvReport;
}

export class ReportScheduleDto {
  @ApiProperty({ enum: ['WEEKLY', 'MONTHLY'] }) @IsIn(['WEEKLY', 'MONTHLY']) frequency!: 'WEEKLY' | 'MONTHLY';
  @ApiProperty({ type: [String], description: 'Team members (user ids) who receive it; each needs reports:read' }) @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true }) recipientUserIds!: string[];
  @ApiProperty() @IsBoolean() isActive!: boolean;
}

@ApiTags('analytics')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@RequirePermissions('reports:read')
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService, private readonly audit: AuditService, private readonly prisma: PrismaService, private readonly schedules: ReportSchedulesService) {}

  @Get('schedules')
  @ApiOperation({ summary: 'Weekly / monthly email reports and who can receive them (Business, Enterprise, Pay as you sell)' })
  listSchedules(@CurrentTenant() t: TenantContext) {
    return this.schedules.list(t.tenantId);
  }

  @RequirePermissions('reports:read', 'store:manage') @Put('schedules')
  @ApiOperation({ summary: 'Set up or change the weekly or monthly email report' })
  saveSchedule(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ReportScheduleDto) {
    return this.schedules.save(t.tenantId, u.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Sales and live-selling analytics for a date range: summary vs previous period, daily series, channels, sessions, top products' })
  async report(@CurrentTenant() t: TenantContext, @Query() q: AnalyticsQueryDto) {
    const tier = await this.analytics.assertEnabled(t.tenantId);
    return this.analytics.report(t.tenantId, q, tier);
  }

  @Get('export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'One table of the report as CSV (summary, daily, channels, sessions, products)' })
  async csv(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Query() q: AnalyticsExportDto) {
    const tier = await this.analytics.assertEnabled(t.tenantId);
    const kind = q.report ?? 'summary';
    if (ADVANCED_CSV.includes(kind) && tier !== 'advanced') {
      throw new ForbiddenException({ code: 'FEATURE_NOT_IN_PLAN', feature: `analytics.${kind}`, message: 'This report is on the Business and Enterprise plans (and Pay as you sell).' });
    }
    const r = await this.analytics.report(t.tenantId, q, tier);
    await this.audit.record({ action: 'analytics.exported', actorId: u.id, tenantId: t.tenantId, entityType: 'report', metadata: { format: 'csv', report: kind, from: r.range.from, to: r.range.to } });
    return new StreamableFile(Buffer.from(reportCsv(r, kind), 'utf8'), {
      type: 'text/csv; charset=utf-8', disposition: `attachment; filename="livesell-${kind}-${r.range.from}-to-${r.range.to}.csv"`,
    });
  }

  @Get('report.pdf')
  @ApiProduces('application/pdf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'The whole report as a printable PDF (Business, Enterprise, Pay as you sell)' })
  async pdf(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Query() q: AnalyticsQueryDto) {
    const tier = await this.analytics.assertEnabled(t.tenantId);
    this.analytics.assertTier(tier, 'pdf');
    const r = await this.analytics.report(t.tenantId, q, tier);
    const store = await this.prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId }, select: { businessName: true, slug: true } });
    const pdf = await reportPdf(r, store);
    await this.audit.record({ action: 'analytics.exported', actorId: u.id, tenantId: t.tenantId, entityType: 'report', metadata: { format: 'pdf', from: r.range.from, to: r.range.to } });
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="livesell-report-${r.range.from}-to-${r.range.to}.pdf"` });
  }
}
