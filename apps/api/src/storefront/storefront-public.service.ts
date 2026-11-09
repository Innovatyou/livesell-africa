import { Injectable, NotFoundException } from '@nestjs/common';
import type { MediaEntry } from '../catalog/products.service';
import { normaliseCode } from '../catalog/catalog-utils';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const NOT_FOUND = 'Store not found';
type Availability = 'in_stock' | 'low_stock' | 'out_of_stock';

/**
 * Public storefront API (MASTER-SPEC §10). Read-only and unauthenticated, so it exposes only what a customer should
 * see: no cost prices, no exact stock (only in stock / low / out, plus "only N left" when low), no drafts, no
 * archived products, no inactive variants. A store is visible only when published, not suspended/closed, and on a
 * live subscription. Tenant resolution is by slug; all queries are then tenant-scoped.
 */
@Injectable()
export class StorefrontPublicService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async store(slug: string) {
    const { tenant, settings } = await this.resolve(slug);
    const db = this.prisma.forTenant(tenant.id);
    const categories = await db.productCategory.findMany({
      where: { products: { some: { status: 'ACTIVE', deletedAt: null } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true, slug: true },
    });
    return {
      slug: tenant.slug, businessName: tenant.businessName, verified: !!tenant.verifiedAt,
      city: tenant.city, state: tenant.state, currency: tenant.defaultCurrency,
      description: settings.description, orderInstructions: settings.orderInstructions,
      whatsappNumber: settings.whatsappNumber, contactPhone: settings.contactPhone, contactEmail: settings.contactEmail,
      socialLinks: settings.socialLinks, accentColor: (settings.theme as { accentColor?: string }).accentColor ?? null,
      logoUrl: settings.logoKey ? await this.storage.readUrl(settings.logoKey, 'logo') : null,
      coverUrl: settings.coverKey ? await this.storage.readUrl(settings.coverKey, 'cover') : null,
      categories,
    };
  }

  async products(slug: string, q: { search?: string; category?: string; sort?: 'newest' | 'price_asc' | 'price_desc'; page?: number; pageSize?: number }) {
    const { tenant } = await this.resolve(slug);
    const t = Prisma.sql`${tenant.id}::uuid`;
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 24;
    const where: Prisma.Sql[] = [Prisma.sql`p.tenant_id = ${t}`, Prisma.sql`p.deleted_at IS NULL`, Prisma.sql`p.status = 'ACTIVE'`, Prisma.sql`s.price_min IS NOT NULL`];
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(Prisma.sql`(p.name ILIKE ${like} OR p.product_code ILIKE ${like} OR ${q.search.toLowerCase()} = ANY(p.tags))`);
    }
    if (q.category) where.push(Prisma.sql`c.slug = ${q.category}`);
    const order = { newest: Prisma.sql`p.created_at DESC`, price_asc: Prisma.sql`s.price_min ASC, p.name`, price_desc: Prisma.sql`s.price_min DESC, p.name` }[q.sort ?? 'newest'];
    const rows = await this.prisma.$queryRaw<Array<{
      name: string; slug: string; productCode: string; media: MediaEntry[]; categoryName: string | null;
      priceMin: bigint; regularMin: bigint; available: number; lowThreshold: number; total: number;
    }>>`
      WITH s AS (
        SELECT v.product_id,
               MIN(COALESCE(v.promo_price_minor, v.price_minor)) AS price_min,
               MIN(v.price_minor) AS regular_min,
               COALESCE(SUM(GREATEST(i.on_hand - i.reserved, 0)), 0)::int AS available
        FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id AND i.tenant_id = ${t}
        WHERE v.tenant_id = ${t} AND v.is_active
        GROUP BY v.product_id
      )
      SELECT p.name, p.slug, p.product_code AS "productCode", p.media, c.name AS "categoryName",
             s.price_min AS "priceMin", s.regular_min AS "regularMin", s.available, p.low_stock_threshold AS "lowThreshold",
             (COUNT(*) OVER())::int AS total
      FROM products p
      JOIN s ON s.product_id = p.id
      LEFT JOIN product_categories c ON c.id = p.category_id AND c.tenant_id = ${t}
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const items = await Promise.all(rows.map(async (r) => {
      const image = (r.media ?? []).find((m) => m.type === 'image');
      return {
        name: r.name, slug: r.slug, productCode: r.productCode, category: r.categoryName,
        priceMinor: r.priceMin, compareAtMinor: r.regularMin > r.priceMin ? r.regularMin : null,
        availability: availability(r.available, r.lowThreshold),
        imageUrl: image ? await this.storage.readUrl(image.key, 'product-image') : null,
      };
    }));
    return { items, total: rows[0]?.total ?? 0, page, pageSize };
  }

  async product(slug: string, productSlug: string) {
    const { tenant } = await this.resolve(slug);
    return this.productDetail(tenant.id, { slug: productSlug });
  }

  /** "Send BAG001 to order": a customer types a code and gets the product. Case and spaces don't matter. */
  async productByCode(slug: string, code: string) {
    const { tenant } = await this.resolve(slug);
    return this.productDetail(tenant.id, { productCode: normaliseCode(code) });
  }

  private async productDetail(tenantId: string, where: { slug?: string; productCode?: string }) {
    const p = await this.prisma.forTenant(tenantId).product.findFirst({
      where: { ...where, status: 'ACTIVE', deletedAt: null },
      include: {
        category: { select: { name: true, slug: true } },
        variants: { where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], include: { inventory: { select: { onHand: true, reserved: true } } } },
      },
    });
    if (!p || !p.variants.length) throw new NotFoundException('Product not found');
    const media = await Promise.all(((p.media as unknown as MediaEntry[]) ?? []).map(async (m) => ({
      type: m.type, alt: m.alt ?? p.name, url: await this.storage.readUrl(m.key, m.type === 'video' ? 'product-video' : 'product-image'),
    })));
    const variants = p.variants.map((v) => {
      const available = Math.max(0, (v.inventory?.onHand ?? 0) - (v.inventory?.reserved ?? 0));
      const state = availability(available, p.lowStockThreshold);
      return {
        id: v.id, name: v.name, sku: v.sku, attributes: v.attributes as Record<string, string>,
        priceMinor: v.promoPriceMinor ?? v.priceMinor, compareAtMinor: v.promoPriceMinor !== null ? v.priceMinor : null,
        availability: state, ...(state === 'low_stock' ? { onlyLeft: available } : {}),
      };
    });
    const options = new Map<string, string[]>();
    for (const v of variants) for (const [k, val] of Object.entries(v.attributes)) {
      const list = options.get(k) ?? [];
      if (!list.includes(val)) list.push(val);
      options.set(k, list);
    }
    return {
      name: p.name, slug: p.slug, productCode: p.productCode, description: p.description, category: p.category, tags: p.tags,
      currency: p.currency, media, variants, options: [...options].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ name, values })),
    };
  }

  private async resolve(slug: string) {
    const tenant = await this.resolveTenant(slug);
    return { tenant, settings: tenant.storefront! };
  }

  /**
   * Store by slug for public use. By default the store must be published, not suspended/closed and on a live
   * subscription. `allowUnpublished` (order tracking) still requires the tenant to exist and not be closed.
   */
  async resolveTenant(slug: string, opts: { allowUnpublished?: boolean } = {}) {
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw new NotFoundException(NOT_FOUND);
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true, slug: true, businessName: true, status: true, city: true, state: true, verifiedAt: true, defaultCurrency: true,
        storefront: true,
        subscriptions: { where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true }, take: 1 },
      },
    });
    if (opts.allowUnpublished) {
      if (!tenant || tenant.status === 'CLOSED') throw new NotFoundException(NOT_FOUND);
      return tenant;
    }
    // One 404 for every reason (unknown, unpublished, suspended, lapsed) — nothing to enumerate.
    if (!tenant || !tenant.storefront?.isPublished || tenant.status === 'SUSPENDED' || tenant.status === 'CLOSED' || !tenant.subscriptions.length) {
      throw new NotFoundException(NOT_FOUND);
    }
    return tenant;
  }
}

function availability(available: number, threshold: number): Availability {
  return available <= 0 ? 'out_of_stock' : available <= threshold ? 'low_stock' : 'in_stock';
}
