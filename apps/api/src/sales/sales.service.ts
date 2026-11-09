import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import type { SalesInquiryStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSalesInquiryDto, UpdateSalesInquiryDto } from './sales.dto';

export interface SalesInquiryNotice { id: string; fullName: string; email: string; businessName: string; planInterest?: string | null }

/** Port: tells the sales team about a new enquiry. Email via Veltrix in Phase 8; logged until then. */
export abstract class SalesNotifier {
  abstract newInquiry(n: SalesInquiryNotice): Promise<void>;
}

@Injectable()
export class LogSalesNotifier extends SalesNotifier {
  private readonly logger = new Logger('SalesNotifier');
  async newInquiry(n: SalesInquiryNotice) {
    // Names only; contact details stay in the database (admin endpoint), not in logs.
    this.logger.log(`New sales enquiry ${n.id.slice(0, 8)} from ${n.businessName}${n.planInterest ? ` (${n.planInterest})` : ''}`);
  }
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifier: SalesNotifier) {}

  /** Stores the enquiry. Honeypot hits get the same response but nothing is stored or sent. */
  async create(dto: CreateSalesInquiryDto, meta: { ip?: string; userAgent?: string }) {
    if (dto.website) return { status: 'received' as const, reference: null };
    const row = await this.prisma.salesInquiry.create({
      data: {
        fullName: dto.fullName, email: dto.email, phone: dto.phone, businessName: dto.businessName, planInterest: dto.planInterest,
        monthlyOrders: dto.monthlyOrders, message: dto.message, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 512),
      },
      select: { id: true, fullName: true, email: true, businessName: true, planInterest: true },
    });
    try {
      await this.notifier.newInquiry(row);
    } catch (e) {
      // The enquiry is saved and visible to admins even if the notification fails.
      this.logger.error(`Sales notification failed for ${row.id}: ${(e as Error).message}`);
    }
    return { status: 'received' as const, reference: row.id.slice(0, 8).toUpperCase() };
  }

  list(status?: SalesInquiryStatus) {
    return this.prisma.salesInquiry.findMany({
      where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200,
      select: {
        id: true, fullName: true, email: true, phone: true, businessName: true, planInterest: true, monthlyOrders: true,
        message: true, status: true, notes: true, handledBy: true, createdAt: true, updatedAt: true,
      },
    });
  }

  async update(id: string, dto: UpdateSalesInquiryDto, actorId: string) {
    const exists = await this.prisma.salesInquiry.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Enquiry not found');
    const row = await this.prisma.salesInquiry.update({ where: { id }, data: { status: dto.status, notes: dto.notes, handledBy: actorId } });
    await this.audit.record({ action: 'sales_inquiry.updated', actorId, entityType: 'sales_inquiry', entityId: id, metadata: { status: dto.status } });
    return row;
  }
}
