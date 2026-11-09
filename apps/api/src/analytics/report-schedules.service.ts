import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import type { ReportFrequency } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { lagosHour, lastCompleteMonth, lastCompleteWeek } from './analytics-math';
import { AnalyticsService } from './analytics.service';

const SEND_FROM_HOUR = 7; // Lagos time; reports go out in the morning after the period closes

/**
 * Scheduled analytics emails (advanced tier: Business, Enterprise, Pay as you sell). One weekly and one monthly
 * schedule per store; recipients are members who can read reports. Sent once per period per person (dedupe key),
 * through NotificationService (billed to the store like every seller message). If the store's plan no longer has
 * the advanced tier, nothing is sent and the schedule waits.
 */
@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  /** Members who may receive reports (active, with reports:read). */
  async eligible(tenantId: string) {
    const members = await this.prisma.forTenant(tenantId).tenantMember.findMany({
      where: { status: 'ACTIVE', role: { permissions: { some: { permission: { key: 'reports:read' } } } } },
      select: { user: { select: { id: true, fullName: true, email: true } } },
    });
    return members.map((m) => m.user);
  }

  async list(tenantId: string) {
    const [schedules, recipients, tier] = await Promise.all([
      this.prisma.forTenant(tenantId).reportSchedule.findMany({ orderBy: { frequency: 'asc' } }),
      this.eligible(tenantId),
      this.analytics.tier(tenantId),
    ]);
    return { available: tier === 'advanced', schedules, recipients };
  }

  async save(tenantId: string, actorId: string, dto: { frequency: ReportFrequency; recipientUserIds: string[]; isActive: boolean }) {
    this.analytics.assertTier(await this.analytics.assertEnabled(tenantId), 'schedules');
    const allowed = new Set((await this.eligible(tenantId)).map((u) => u.id));
    const ids = [...new Set(dto.recipientUserIds)];
    const bad = ids.filter((id) => !allowed.has(id));
    if (bad.length) throw new BadRequestException('Reports can only go to team members who can view analytics');
    if (dto.isActive && !ids.length) throw new BadRequestException('Choose at least one person to receive the report');
    const db = this.prisma.forTenant(tenantId);
    const existing = await db.reportSchedule.findFirst({ where: { frequency: dto.frequency } });
    const row = existing
      ? await db.reportSchedule.update({ where: { id: existing.id }, data: { recipientUserIds: ids, isActive: dto.isActive } })
      : await db.reportSchedule.create({ data: { frequency: dto.frequency, recipientUserIds: ids, isActive: dto.isActive, createdBy: actorId } as never });
    await this.audit.record({ action: 'analytics.schedule_saved', actorId, tenantId, entityType: 'report_schedule', entityId: row.id, metadata: { frequency: dto.frequency, recipients: ids.length, isActive: dto.isActive } });
    return this.list(tenantId);
  }

  /** Job (hourly; idempotent): send every report whose period has closed and wasn't sent yet. */
  async runDue(now = new Date()) {
    if (lagosHour(now) < SEND_FROM_HOUR) return { due: 0, sent: 0 };
    const schedules = await this.prisma.reportSchedule.findMany({ where: { isActive: true }, take: 1000 });
    let sent = 0;
    let due = 0;
    for (const s of schedules) {
      const p = s.frequency === 'WEEKLY' ? lastCompleteWeek(now) : lastCompleteMonth(now);
      if (s.lastPeriod === p.label) continue;
      due++;
      try {
        sent += await this.send(s.id, s.tenantId, s.frequency, s.recipientUserIds, p);
      } catch (e) {
        this.logger.error(`Report ${s.id} (${p.label}): ${(e as Error).message}`);
      }
    }
    return { due, sent };
  }

  private async send(id: string, tenantId: string, frequency: ReportFrequency, recipientIds: string[], p: { from: string; to: string; label: string; periodLabel: string }) {
    if ((await this.analytics.tier(tenantId)) !== 'advanced') return 0; // plan changed: wait, don't mark sent
    const r = await this.analytics.report(tenantId, { from: p.from, to: p.to }, 'advanced');
    const store = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true } });
    const people = (await this.eligible(tenantId)).filter((u) => recipientIds.includes(u.id)); // still members who can read reports
    const best = r.channels[0];
    const vars = {
      storeName: store.businessName, frequency, periodLabel: p.periodLabel, from: p.from, to: p.to, currency: r.currency,
      grossSalesMinor: r.overview.grossSalesMinor.toString(), previousGrossSalesMinor: String(r.comparison.grossSalesMinor.previous),
      netSalesMinor: r.overview.netSalesMinor.toString(), refundsMinor: r.overview.refundsMinor.toString(),
      orders: r.overview.orders, previousOrders: Number(r.comparison.orders.previous), paidOrders: r.overview.paidOrders,
      averageOrderValueMinor: r.overview.averageOrderValueMinor.toString(), paymentCompletionBps: r.overview.paymentCompletionBps,
      newCustomers: r.overview.newCustomers, liveSessions: r.overview.liveSessions,
      topProduct: r.topProducts[0] ? { name: r.topProducts[0].name, productCode: r.topProducts[0].productCode, unitsSold: r.topProducts[0].unitsSold } : null,
      bestChannel: best && best.grossSalesMinor > 0n ? { name: best.name, grossSalesMinor: best.grossSalesMinor.toString() } : null,
    };
    let sent = 0;
    for (const u of people) {
      const out = await this.notifications.send({
        tenantId, channel: 'EMAIL', type: 'ANALYTICS_REPORT', template: 'ANALYTICS_REPORT', destination: u.email, toName: u.fullName,
        vars, dedupeKey: `report:${id}:${p.label}:${u.id}`,
      });
      if (!out.duplicate) sent++;
    }
    await this.prisma.reportSchedule.update({ where: { id }, data: { lastPeriod: p.label } });
    return sent;
  }
}
