import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { cleanTags, isUniqueViolation } from '../catalog/products.service';
import { koboToNaira, toCsv } from '../catalog/catalog-utils';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddressDto, CreateCustomerDto, ListCustomersQuery, Segment, UpdateCustomerDto } from './customers.dto';

const PAID = Prisma.sql`('PAID','PARTIALLY_REFUNDED')`;
const OPEN = Prisma.sql`('PENDING_PAYMENT','PAYMENT_VERIFICATION','PAID','PROCESSING','READY_FOR_DISPATCH','DISPATCHED')`;
const FINISHED = ['DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

interface StatsRow {
  id: string; fullName: string; phone: string | null; email: string | null; whatsappOptIn: boolean; tags: string[];
  createdAt: Date; anonymizedAt: Date | null; orderCount: number; paidCount: number; totalSpentMinor: bigint;
  outstanding: number; lastOrderAt: Date | null; firstOrderAt: Date | null; vip: boolean; total: number;
}

/**
 * Lightweight CRM (MASTER-SPEC §17). Spending and order figures are computed from orders every time (paid orders,
 * workspace currency) — nothing is denormalised that could drift.
 *
 * Segments: repeat = 2+ paid orders · new = added in the last 30 days · vip = top 10% by paid spend ·
 * inactive = has bought, nothing in 90 days · outstanding = open orders · opted_in = WhatsApp opt-in.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(tenantId: string, q: ListCustomersQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const rows = await this.query(tenantId, q, pageSize, (page - 1) * pageSize);
    return { items: rows.map(({ total: _t, ...r }) => ({ ...r, repeat: r.paidCount >= 2 })), total: rows[0]?.total ?? 0, page, pageSize };
  }

  async get(tenantId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const c = await db.customer.findUnique({ where: { id }, include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } } });
    if (!c) throw new NotFoundException('Customer not found');
    const [stats] = await this.query(tenantId, {}, 1, 0, id);
    const orders = await db.order.findMany({
      where: { customerId: id, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, reference: true, status: true, paymentStatus: true, totalMinor: true, currency: true, createdAt: true },
    });
    return {
      ...c,
      stats: {
        orderCount: stats?.orderCount ?? 0, paidCount: stats?.paidCount ?? 0, totalSpentMinor: stats?.totalSpentMinor ?? 0n,
        outstanding: stats?.outstanding ?? 0, lastOrderAt: stats?.lastOrderAt ?? null, firstOrderAt: stats?.firstOrderAt ?? null,
        repeat: (stats?.paidCount ?? 0) >= 2, vip: !!stats?.vip,
      },
      orders,
    };
  }

  async create(tenantId: string, actorId: string, dto: CreateCustomerDto) {
    if (!dto.phone && !dto.email) throw new BadRequestException('Add a phone number or an email address');
    if (dto.phone) await this.assertPhoneFree(tenantId, dto.phone);
    try {
      const c = await this.prisma.tenantTransaction(tenantId, async (tx) => {
        const row = await tx.customer.create({
          data: {
            fullName: dto.fullName, phone: dto.phone ?? null, email: dto.email ?? null, tags: cleanTags(dto.tags), notes: dto.notes ?? null,
            whatsappOptIn: dto.whatsappOptIn ?? false, optInAt: dto.whatsappOptIn ? new Date() : null,
          } as Prisma.CustomerUncheckedCreateInput,
        });
        if (dto.address) await tx.customerAddress.create({ data: { ...addressData(dto.address), customerId: row.id, isDefault: true } as Prisma.CustomerAddressUncheckedCreateInput });
        return row;
      });
      await this.audit.record({ action: 'customer.created', actorId, tenantId, entityType: 'customer', entityId: c.id });
      return this.get(tenantId, c.id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A customer with this phone number already exists');
      throw e;
    }
  }

  async update(tenantId: string, actorId: string, id: string, dto: UpdateCustomerDto) {
    const db = this.prisma.forTenant(tenantId);
    const c = await db.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Customer not found');
    if (c.anonymizedAt) throw new ConflictException("This customer's personal data was erased and can't be edited");
    const phone = dto.phone === undefined ? c.phone : dto.phone;
    const email = dto.email === undefined ? c.email : dto.email;
    if (!phone && !email) throw new BadRequestException('Keep a phone number or an email address');
    if (dto.phone && dto.phone !== c.phone) await this.assertPhoneFree(tenantId, dto.phone, id);
    try {
      await db.customer.update({
        where: { id },
        data: {
          fullName: dto.fullName, phone: dto.phone, email: dto.email, notes: dto.notes, tags: dto.tags ? cleanTags(dto.tags) : undefined,
          whatsappOptIn: dto.whatsappOptIn,
          optInAt: dto.whatsappOptIn === undefined || dto.whatsappOptIn === c.whatsappOptIn ? undefined : dto.whatsappOptIn ? new Date() : null,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A customer with this phone number already exists');
      throw e;
    }
    await this.audit.record({
      action: 'customer.updated', actorId, tenantId, entityType: 'customer', entityId: id,
      metadata: { fields: Object.keys(dto), whatsappOptIn: dto.whatsappOptIn },
    });
    return this.get(tenantId, id);
  }

  /** Hard delete — only for customers who never ordered (otherwise anonymise). */
  async remove(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    if (!(await db.customer.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Customer not found');
    if (await db.order.count({ where: { customerId: id } })) {
      throw new ConflictException({ code: 'HAS_ORDERS', message: 'This customer has orders. Erase their personal data instead, so your order records stay complete.' });
    }
    await db.customer.delete({ where: { id } });
    await this.audit.record({ action: 'customer.deleted', actorId, tenantId, entityType: 'customer', entityId: id });
  }

  /**
   * Right to erasure (NDPA): removes name, contact details, notes, tags, addresses and the delivery addresses
   * copied onto finished orders. Order amounts stay for accounting. Refused while orders are still open.
   */
  async anonymise(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const c = await db.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Customer not found');
    if (c.anonymizedAt) return this.get(tenantId, id);
    if (await db.order.count({ where: { customerId: id, status: { notIn: [...FINISHED, 'DRAFT'] } } })) {
      throw new ConflictException({ code: 'OPEN_ORDERS', message: 'Finish or cancel this customer’s open orders before erasing their data' });
    }
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      await tx.customerAddress.deleteMany({ where: { customerId: id } });
      await tx.order.updateMany({ where: { customerId: id }, data: { shippingAddress: Prisma.DbNull, notes: null } });
      await tx.customer.update({
        where: { id },
        data: { fullName: 'Erased customer', phone: null, email: null, notes: null, tags: [], whatsappOptIn: false, optInAt: null, anonymizedAt: new Date() },
      });
    });
    await this.audit.record({ action: 'customer.anonymised', actorId, tenantId, entityType: 'customer', entityId: id });
    return this.get(tenantId, id);
  }

  // ── addresses ──

  async addAddress(tenantId: string, actorId: string, customerId: string, dto: AddressDto) {
    await this.mustBeEditable(tenantId, customerId);
    const row = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const first = (await tx.customerAddress.count({ where: { customerId } })) === 0;
      if (dto.isDefault) await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
      return tx.customerAddress.create({ data: { ...addressData(dto), customerId, isDefault: dto.isDefault ?? first } as Prisma.CustomerAddressUncheckedCreateInput });
    });
    await this.audit.record({ action: 'customer.address_added', actorId, tenantId, entityType: 'customer', entityId: customerId });
    return row;
  }

  async updateAddress(tenantId: string, actorId: string, customerId: string, addressId: string, dto: AddressDto) {
    await this.mustBeEditable(tenantId, customerId);
    const row = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const found = await tx.customerAddress.findFirst({ where: { id: addressId, customerId } });
      if (!found) throw new NotFoundException('Address not found');
      if (dto.isDefault) await tx.customerAddress.updateMany({ where: { customerId, id: { not: addressId } }, data: { isDefault: false } });
      return tx.customerAddress.update({ where: { id: addressId }, data: { ...addressData(dto), isDefault: dto.isDefault ?? found.isDefault } });
    });
    await this.audit.record({ action: 'customer.address_updated', actorId, tenantId, entityType: 'customer', entityId: customerId });
    return row;
  }

  async removeAddress(tenantId: string, actorId: string, customerId: string, addressId: string) {
    await this.mustBeEditable(tenantId, customerId);
    const res = await this.prisma.forTenant(tenantId).customerAddress.deleteMany({ where: { id: addressId, customerId } });
    if (!res.count) throw new NotFoundException('Address not found');
    await this.audit.record({ action: 'customer.address_removed', actorId, tenantId, entityType: 'customer', entityId: customerId });
  }

  /** Personal-data export: permission-gated (customers:export) and audited. Erased customers are excluded. */
  async exportCsv(tenantId: string, actorId: string, q: ListCustomersQuery, ip?: string) {
    const rows = (await this.query(tenantId, q, 50_000, 0)).filter((r) => !r.anonymizedAt);
    await this.audit.record({ action: 'customers.exported', actorId, tenantId, entityType: 'customer', metadata: { count: rows.length, segment: q.segment ?? 'all', tag: q.tag }, ip });
    return toCsv(
      ['name', 'phone', 'email', 'whatsapp_opt_in', 'tags', 'orders', 'paid_orders', 'total_spent', 'open_orders', 'last_order_at', 'customer_since'],
      rows.map((r) => [
        r.fullName, r.phone ?? '', r.email ?? '', r.whatsappOptIn ? 'yes' : 'no', r.tags.join('; '), r.orderCount, r.paidCount,
        koboToNaira(r.totalSpentMinor), r.outstanding, r.lastOrderAt?.toISOString() ?? '', r.createdAt.toISOString(),
      ]),
    );
  }

  async tags(tenantId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ tag: string; count: number }>>`
      SELECT tag, COUNT(*)::int AS count FROM customers, unnest(tags) AS tag
      WHERE tenant_id = ${tenantId}::uuid GROUP BY tag ORDER BY count DESC, tag LIMIT 100`;
    return rows;
  }

  // ── internals ──

  /** One query for list, detail and export. Every table is filtered by the tenant id (bound parameter). */
  private async query(tenantId: string, q: Partial<ListCustomersQuery>, limit: number, offset: number, onlyId?: string) {
    const t = Prisma.sql`${tenantId}::uuid`;
    const { defaultCurrency } = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
    const where: Prisma.Sql[] = [Prisma.sql`c.tenant_id = ${t}`];
    if (onlyId) where.push(Prisma.sql`c.id = ${onlyId}::uuid`);
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const digits = q.search.replace(/\D/g, '');
      where.push(Prisma.sql`(c.full_name ILIKE ${like} OR c.email ILIKE ${like}${digits.length >= 4 ? Prisma.sql` OR c.phone LIKE ${`%${digits}%`}` : Prisma.empty})`);
    }
    if (q.tag) where.push(Prisma.sql`${q.tag} = ANY(c.tags)`);
    const seg: Record<Segment, Prisma.Sql | null> = {
      all: null,
      repeat: Prisma.sql`COALESCE(o.paid_count, 0) >= 2`,
      new: Prisma.sql`c.created_at >= now() - interval '30 days'`,
      vip: Prisma.sql`r.pr IS NOT NULL AND r.pr <= 0.1`,
      inactive: Prisma.sql`COALESCE(o.paid_count, 0) >= 1 AND o.last_order_at < now() - interval '90 days'`,
      outstanding: Prisma.sql`COALESCE(o.outstanding, 0) > 0`,
      opted_in: Prisma.sql`c.whatsapp_opt_in`,
    };
    const s = seg[q.segment ?? 'all'];
    if (s) where.push(s);
    const order = {
      recent: Prisma.sql`c.created_at DESC`, spend: Prisma.sql`COALESCE(o.total_spent, 0) DESC, c.created_at DESC`,
      orders: Prisma.sql`COALESCE(o.order_count, 0) DESC, c.created_at DESC`, last_order: Prisma.sql`o.last_order_at DESC NULLS LAST`,
      name: Prisma.sql`c.full_name ASC`,
    }[q.sort ?? 'recent'];

    return this.prisma.$queryRaw<StatsRow[]>`
      WITH o AS (
        SELECT customer_id,
               COUNT(*) FILTER (WHERE status NOT IN ('DRAFT','CANCELLED'))::int AS order_count,
               COUNT(*) FILTER (WHERE payment_status IN ${PAID})::int AS paid_count,
               COALESCE(SUM(total_minor) FILTER (WHERE payment_status IN ${PAID} AND currency = ${defaultCurrency}), 0)::bigint AS total_spent,
               COUNT(*) FILTER (WHERE status IN ${OPEN})::int AS outstanding,
               MAX(created_at) FILTER (WHERE status <> 'DRAFT') AS last_order_at,
               MIN(created_at) FILTER (WHERE status <> 'DRAFT') AS first_order_at
        FROM orders WHERE tenant_id = ${t} AND customer_id IS NOT NULL
        GROUP BY customer_id
      ), r AS (
        SELECT customer_id, PERCENT_RANK() OVER (ORDER BY total_spent DESC) AS pr FROM o WHERE total_spent > 0
      )
      SELECT c.id, c.full_name AS "fullName", c.phone, c.email, c.whatsapp_opt_in AS "whatsappOptIn", c.tags, c.created_at AS "createdAt",
             c.anonymized_at AS "anonymizedAt", COALESCE(o.order_count, 0) AS "orderCount", COALESCE(o.paid_count, 0) AS "paidCount",
             COALESCE(o.total_spent, 0)::bigint AS "totalSpentMinor", COALESCE(o.outstanding, 0) AS outstanding,
             o.last_order_at AS "lastOrderAt", o.first_order_at AS "firstOrderAt", COALESCE(r.pr <= 0.1, false) AS vip,
             (COUNT(*) OVER())::int AS total
      FROM customers c
      LEFT JOIN o ON o.customer_id = c.id
      LEFT JOIN r ON r.customer_id = c.id
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset}`;
  }

  private async assertPhoneFree(tenantId: string, phone: string, exceptId?: string) {
    const other = await this.prisma.forTenant(tenantId).customer.findFirst({ where: { phone, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (other) throw new ConflictException({ code: 'DUPLICATE_PHONE', customerId: other.id, message: 'A customer with this phone number already exists' });
  }

  private async mustBeEditable(tenantId: string, customerId: string) {
    const c = await this.prisma.forTenant(tenantId).customer.findUnique({ where: { id: customerId }, select: { anonymizedAt: true } });
    if (!c) throw new NotFoundException('Customer not found');
    if (c.anonymizedAt) throw new ConflictException("This customer's personal data was erased");
  }
}

function addressData(a: AddressDto) {
  return { label: a.label ?? null, line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, country: a.country ?? 'NG', landmark: a.landmark ?? null };
}
