import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from './catalog-utils';

/** Product categories (one level of nesting is typical; any depth is allowed, cycles are not). */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId).productCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, parentId: true, sortOrder: true, _count: { select: { products: { where: { deletedAt: null } } } } },
    });
  }

  async create(tenantId: string, actorId: string, dto: { name: string; parentId?: string | null; sortOrder?: number }) {
    const db = this.prisma.forTenant(tenantId);
    if (dto.parentId) await this.mustExist(tenantId, dto.parentId);
    const slug = await this.uniqueSlug(tenantId, slugify(dto.name, 60));
    const row = await db.productCategory.create({
      data: { name: dto.name, slug, parentId: dto.parentId ?? null, sortOrder: dto.sortOrder ?? 0 } as Prisma.ProductCategoryUncheckedCreateInput,
    });
    await this.audit.record({ action: 'category.created', actorId, tenantId, entityType: 'product_category', entityId: row.id });
    return row;
  }

  async update(tenantId: string, actorId: string, id: string, dto: { name?: string; parentId?: string | null; sortOrder?: number }) {
    const db = this.prisma.forTenant(tenantId);
    await this.mustExist(tenantId, id);
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
      await this.mustExist(tenantId, dto.parentId);
      // Walk up from the new parent; reaching `id` would create a cycle.
      let cursor: string | null = dto.parentId;
      for (let depth = 0; cursor && depth < 50; depth++) {
        if (cursor === id) throw new BadRequestException('That would put the category inside itself');
        const parent: { parentId: string | null } | null = await db.productCategory.findUnique({ where: { id: cursor }, select: { parentId: true } });
        cursor = parent?.parentId ?? null;
      }
    }
    const row = await db.productCategory.update({ where: { id }, data: { name: dto.name, parentId: dto.parentId, sortOrder: dto.sortOrder } });
    await this.audit.record({ action: 'category.updated', actorId, tenantId, entityType: 'product_category', entityId: id });
    return row;
  }

  /** Only empty categories can be deleted; sub-categories move up to the top level. */
  async remove(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    await this.mustExist(tenantId, id);
    if (await db.product.count({ where: { categoryId: id, deletedAt: null } })) {
      throw new ConflictException('Move or archive the products in this category first');
    }
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      await tx.productCategory.updateMany({ where: { parentId: id }, data: { parentId: null } });
      await tx.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } }); // archived/deleted products
      await tx.productCategory.delete({ where: { id } });
    });
    await this.audit.record({ action: 'category.deleted', actorId, tenantId, entityType: 'product_category', entityId: id });
  }

  /** Finds a category by (case-insensitive) name or creates it — used by CSV import. */
  async findOrCreateByName(tx: Prisma.TransactionClient, tenantId: string, name: string) {
    const existing = await tx.productCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) return existing;
    const slug = await this.uniqueSlug(tenantId, slugify(name, 60), tx);
    return tx.productCategory.create({ data: { name, slug } as Prisma.ProductCategoryUncheckedCreateInput });
  }

  /** Same-tenant check for a category id supplied by the client (rule 1: verify linked records' tenant). */
  async mustExist(tenantId: string, id: string) {
    const row = await this.prisma.forTenant(tenantId).productCategory.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!row) throw new NotFoundException('Category not found');
    return row;
  }

  private async uniqueSlug(tenantId: string, base: string, tx?: Prisma.TransactionClient) {
    // Tenant-scoped either way: `tx` comes from prisma.tenantTransaction().
    const db: Prisma.TransactionClient = tx ?? (this.prisma.forTenant(tenantId) as unknown as Prisma.TransactionClient);
    const taken = new Set((await db.productCategory.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}
