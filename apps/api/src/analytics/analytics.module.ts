import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsJobs } from './analytics.jobs';
import { AnalyticsService } from './analytics.service';
import { ReportSchedulesService } from './report-schedules.service';

/** Phase 10 (MASTER-SPEC §19): sales and live-selling analytics, CSV/PDF reports, scheduled email reports (advanced tier). */
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService, ReportSchedulesService, AnalyticsJobs] })
export class AnalyticsModule {}
