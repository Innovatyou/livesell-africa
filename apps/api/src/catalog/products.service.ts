import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CategoriesService } from './categories.service';
import { codePrefix, nextProductCode, normaliseCode, skuFor, slugify, variantName } from './catalog-utils';
import { BulkUpdateDto, CreateProductDto, ListProductsQuery, MediaItemDto, UpdateProductDto, VariantInputDto } from './products.dto';

type Tx = Prisma.TransactionClient;
export interface MediaEntry { type: 'image' | 'video'; key: string; alt?: string; sortOrder: number }

interface NormalisedVariant {
  id?: string; attributes: Record<string, string>; name: string; sku?: string; priceMinor: bigint;
  promoPriceMinor: bigint | null; costPriceMinor: bigint | null; initialStock: number; isActive: boolean;
}

const MAX_ATTRIBUTES = 4;

/**
 * Products and variants (MASTER-SPEC §8). Every sellable unit is a variant with its own inventory row; a simple
 * product has one variant with no attributes. Stock is never edited here — opening stock is booked as a RESTOCK
 * movement and later changes go through InventoryService.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly categories: CategoriesService,
    private readonly inventory: InventoryService,
  ) {}

  // ───────────────────────── reads ─────────────────────────

  async get(tenantId: string, id: string) {
    const p = await this.prisma.forTenant(tenantId).product.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { id: true, name: true } },
        variants: { orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }], include: { inventory: { select: { onHand: true, reserved: true } } } },
      },
    });
    if (!p) throw new NotFoundException('Product not found');
    return this.shape(p);
  }

  async getByCode(tenantId: string, code: string) {
    const p = await this.prisma.forTenant(tenantId).product.findFirst({ where: { productCode: normaliseCode(code), deletedAt: null }, select: { id: true } });
    if (!p) throw new NotFoundException('No product with that code');
    return this.get(tenantId, p.id);
  }

  async list(tenantId: string, q: ListProductsQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const t = Prisma.sql`${tenantId}::uuid`;
    const where: Prisma.Sql[] = [Prisma.sql`p.tenant_id = ${t}`, Prisma.sql`p.deleted_at IS NULL`];
    if (q.status) where.push(Prisma.sql`p.status = ${q.status}::"ProductStatus"`);
    if (q.categoryId) where.push(Prisma.sql`p.category_id = ${q.categoryId}::uuid`);
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(Prisma.sql`(p.name ILIKE ${like} OR p.product_code ILIKE ${like} OR EXISTS (
        SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND sv.tenant_id = ${t} AND sv.sku ILIKE ${like}))`);
    }
    if (q.stock === 'out') where.push(Prisma.sql`COALESCE(s.available, 0) <= 0`);
    if (q.stock === 'in') where.push(Prisma.sql`COALESCE(s.available, 0) > 0`);
    if (q.stock === 'low') where.push(Prisma.sql`s.low AND COALESCE(s.available, 0) > 0`);
    const order = {
      recent: Prisma.sql`p.created_at DESC`, name: Prisma.sql`p.name ASC`,
      price_asc: Prisma.sql`s.price_min ASC NULLS LAST, p.name`, price_desc: Prisma.sql`s.price_max DESC NULLS LAST, p.name`,
    }[q.sort ?? 'recent'];

    const rows = await this.prisma.$queryRaw<Array<{
      id: string; name: string; slug: string; productCode: string; status: string; tags: string[]; media: MediaEntry[];
      categoryId: string | null; categoryName: string | null; variantCount: number; priceMin: bigint | null; priceMax: bigint | null;
      available: number; low: boolean | null; createdAt: Date; total: number;
    }>>`
      WITH s AS (
        SELECT v.product_id,
               COUNT(*) FILTER (WHERE v.is_active)::int AS variant_count,
               MIN(COALESCE(v.promo_price_minor, v.price_minor)) FILTER (WHERE v.is_active) AS price_min,
               MAX(COALESCE(v.promo_price_minor, v.price_minor)) FILTER (WHERE v.is_active) AS price_max,
               COALESCE(SUM(i.on_hand - i.reserved) FILTER (WHERE v.is_active), 0)::int AS available,
               BOOL_OR(v.is_active AND (i.on_hand - i.reserved) <= pp.low_stock_threshold) AS low
        FROM product_variants v
        JOIN products pp ON pp.id = v.product_id AND pp.tenant_id = ${t}
        LEFT JOIN inventory i ON i.variant_id = v.id AND i.tenant_id = ${t}
        WHERE v.tenant_id = ${t}
        GROUP BY v.product_id
      )
      SELECT p.id, p.name, p.slug, p.product_code AS "productCode", p.status::text AS status, p.tags, p.media,
             p.category_id AS "categoryId", c.name AS "categoryName", COALESCE(s.variant_count, 0) AS "variantCount",
             s.price_min AS "priceMin", s.price_max AS "priceMax", COALESCE(s.available, 0) AS available, s.low,
             p.created_at AS "createdAt", (COUNT(*) OVER())::int AS total
      FROM products p
      LEFT JOIN s ON s.product_id = p.id
      LEFT JOIN product_categories c ON c.id = p.category_id AND c.tenant_id = ${t}
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

    const items = await Promise.all(rows.map(async ({ total: _total, media, low, ...r }) => {
      const image = (media ?? []).find((m) => m.type === 'image');
      return {
        ...r, lowStock: !!low && r.available > 0, outOfStock: r.available <= 0,
        thumbnailUrl: image ? await this.storage.readUrl(image.key, 'product-image') : null,
      };
    }));
    return { items, total: rows[0]?.total ?? 0, page, pageSize };
  }

  async suggestCode(tenantId: string, name: string, categoryId?: string) {
    const category = categoryId ? await this.categories.mustExist(tenantId, categoryId) : null;
    const codes = await this.prisma.forTenant(tenantId).product.findMany({ select: { productCode: true } });
    return { productCode: nextProductCode(codePrefix(name, category?.name), codes.map((c) => c.productCode)) };
  }

  // ───────────────────────── writes ─────────────────────────

  async create(tenantId: string, actorId: string, dto: CreateProductDto) {
    await this.entitlements.assertCanAdd(tenantId, 'products');
    const category = dto.categoryId ? await this.categories.mustExist(tenantId, dto.categoryId) : null;
    const variants = this.normaliseVariants(dto.variants, true);
    const status = dto.status ?? 'DRAFT';
    if (status === 'ACTIVE' && !variants.some((v) => v.isActive)) throw new BadRequestException('An active product needs at least one active variant');
    const media = await this.confirmMedia(tenantId, [], dto.media ?? []);

    let created: { id: string; productCode: string } | null = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await this.prisma.tenantTransaction(tenantId, async (tx) => {
          const productCode = dto.productCode ?? (await this.generateCode(tx, dto.name, category?.name));
          if (dto.productCode) await this.assertCodeFree(tx, productCode);
          const p = await tx.product.create({
            data: {
              name: dto.name, slug: await this.uniqueSlug(tx, slugify(dto.name)), productCode, description: dto.description ?? null,
              categoryId: category?.id ?? null, status, tags: cleanTags(dto.tags), media: media.entries as unknown as Prisma.InputJsonArray,
              weightGrams: dto.weightGrams ?? null, dimensionsMm: dto.dimensionsMm ? { ...dto.dimensionsMm } : Prisma.JsonNull,
              lowStockThreshold: dto.lowStockThreshold ?? 5,
            } as Prisma.ProductUncheckedCreateInput,
            select: { id: true, productCode: true },
          });
          await this.writeVariants(tx, tenantId, p, [], variants, actorId);
          return p;
        });
      } catch (e) {
        // Two concurrent creates can generate the same code; retry generated codes, report explicit ones.
        if (isUniqueViolation(e) && !dto.productCode && attempt < 2) continue;
        if (isUniqueViolation(e)) {
          await Promise.all(media.added.map((k) => this.storage.delete(k)));
          throw new ConflictException('That product code or SKU is already used in your store');
        }
        await Promise.all(media.added.map((k) => this.storage.delete(k)));
        throw e;
      }
    }
    await this.audit.record({ action: 'product.created', actorId, tenantId, entityType: 'product', entityId: created!.id, metadata: { productCode: created!.productCode, variants: variants.length } });
    return this.get(tenantId, created!.id);
  }

  async update(tenantId: string, actorId: string, id: string, dto: UpdateProductDto) {
    const db = this.prisma.forTenant(tenantId);
    const existing = await db.product.findFirst({ where: { id, deletedAt: null }, include: { variants: true } });
    if (!existing) throw new NotFoundException('Product not found');
    if (dto.categoryId) await this.categories.mustExist(tenantId, dto.categoryId);
    const variants = dto.variants ? this.normaliseVariants(dto.variants, false) : null;
    const nextStatus = dto.status ?? existing.status;
    const activeAfter = variants ? variants.some((v) => v.isActive) : existing.variants.some((v) => v.isActive);
    if (nextStatus === 'ACTIVE' && !activeAfter) throw new BadRequestException('An active product needs at least one active variant');
    const media = dto.media ? await this.confirmMedia(tenantId, existing.media as unknown as MediaEntry[], dto.media) : null;

    try {
      await this.prisma.tenantTransaction(tenantId, async (tx) => {
        if (dto.productCode && dto.productCode !== existing.productCode) await this.assertCodeFree(tx, dto.productCode);
        await tx.product.update({
          where: { id },
          data: {
            name: dto.name, description: dto.description, categoryId: dto.categoryId, status: dto.status, productCode: dto.productCode,
            tags: dto.tags ? cleanTags(dto.tags) : undefined,
            media: media ? (media.entries as unknown as Prisma.InputJsonArray) : undefined,
            weightGrams: dto.weightGrams, lowStockThreshold: dto.lowStockThreshold,
            dimensionsMm: dto.dimensionsMm === undefined ? undefined : dto.dimensionsMm === null ? Prisma.JsonNull : { ...dto.dimensionsMm },
          },
        });
        if (variants) await this.writeVariants(tx, tenantId, existing, existing.variants, variants, actorId);
      });
    } catch (e) {
      if (media) await Promise.all(media.added.map((k) => this.storage.delete(k)));
      if (isUniqueViolation(e)) throw new ConflictException('That product code or SKU is already used in your store');
      throw e;
    }
    if (media) await Promise.all(media.removed.map((k) => this.storage.delete(k)));
    await this.audit.record({ action: 'product.updated', actorId, tenantId, entityType: 'product', entityId: id, metadata: { fields: Object.keys(dto) } });
    return this.get(tenantId, id);
  }

  /** Soft delete: hidden everywhere, kept for order history. The product code stays reserved. */
  async remove(tenantId: string, actorId: string, id: string) {
    const res = await this.prisma.forTenant(tenantId).product.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
    if (!res.count) throw new NotFoundException('Product not found');
    await this.audit.record({ action: 'product.deleted', actorId, tenantId, entityType: 'product', entityId: id });
  }

  async bulk(tenantId: string, actorId: string, dto: BulkUpdateDto) {
    const db = this.prisma.forTenant(tenantId);
    const ids = [...new Set(dto.productIds)];
    const products = await db.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, tags: true, variants: { select: { id: true, isActive: true, priceMinor: true, promoPriceMinor: true } } } });
    if (products.length !== ids.length) throw new NotFoundException('One or more products were not found');

    let affected = 0;
    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      switch (dto.action) {
        case 'set_status': {
          if (!dto.status) throw new BadRequestException('status is required');
          if (dto.status === 'ACTIVE') {
            const unsellable = products.filter((p) => !p.variants.some((v) => v.isActive)).length;
            if (unsellable) throw new ConflictException(`${unsellable} product(s) have no active variant and can't be activated`);
          }
          affected = (await tx.product.updateMany({ where: { id: { in: ids } }, data: { status: dto.status } })).count;
          break;
        }
        case 'set_category': {
          if (dto.categoryId === undefined) throw new BadRequestException('categoryId is required (null to clear)');
          if (dto.categoryId) await this.categories.mustExist(tenantId, dto.categoryId);
          affected = (await tx.product.updateMany({ where: { id: { in: ids } }, data: { categoryId: dto.categoryId } })).count;
          break;
        }
        case 'add_tags':
        case 'remove_tags': {
          if (!dto.tags?.length) throw new BadRequestException('tags are required');
          const change = cleanTags(dto.tags);
          for (const p of products) {
            const tags = dto.action === 'add_tags' ? cleanTags([...p.tags, ...change]) : p.tags.filter((t) => !change.includes(t));
            await tx.product.update({ where: { id: p.id }, data: { tags } });
            affected++;
          }
          break;
        }
        case 'adjust_price': {
          if (dto.percent === undefined || dto.percent === 0) throw new BadRequestException('percent is required');
          const factor = BigInt(100 + dto.percent);
          const scale = (v: bigint) => (v * factor + 50n) / 100n; // round half up, integer kobo
          for (const p of products) {
            for (const v of p.variants) {
              const price = scale(v.priceMinor);
              const promo = v.promoPriceMinor === null ? null : scale(v.promoPriceMinor);
              await tx.productVariant.update({ where: { id: v.id }, data: { priceMinor: price, promoPriceMinor: promo !== null && promo <= price ? promo : null } });
            }
            affected++;
          }
          break;
        }
      }
    });
    await this.audit.record({ action: 'product.bulk_update', actorId, tenantId, entityType: 'product', metadata: { action: dto.action, count: affected, percent: dto.percent, status: dto.status } });
    return { action: dto.action, updated: affected };
  }

  presignMedia(tenantId: string, contentType: string, contentLength: number) {
    const purpose = contentType.startsWith('video/') ? 'product-video' : 'product-image';
    return this.storage.presignUpload(tenantId, purpose, contentType, contentLength);
  }

  // ───────────────────────── shared with import ─────────────────────────

  normaliseVariants(inputs: VariantInputDto[], creating: boolean): NormalisedVariant[] {
    const keySets = new Set<string>();
    const combos = new Set<string>();
    const out = inputs.map((v, i) => {
      const entries = Object.entries(v.attributes ?? {}).map(([k, val]) => [String(k).trim(), String(val ?? '').trim()] as const);
      if (entries.length > MAX_ATTRIBUTES) throw new BadRequestException(`Variant ${i + 1}: at most ${MAX_ATTRIBUTES} attributes`);
      for (const [k, val] of entries) {
        if (!k || k.length > 30 || !val || val.length > 60) throw new BadRequestException(`Variant ${i + 1}: attribute names (≤30) and values (≤60) are required`);
      }
      const attributes = Object.fromEntries(entries);
      keySets.add(entries.map(([k]) => k.toLowerCase()).sort().join('|'));
      const combo = entries.map(([k, val]) => `${k.toLowerCase()}=${val.toLowerCase()}`).sort().join('|');
      if (combos.has(combo)) throw new BadRequestException(`Variant ${i + 1} duplicates another variant (${variantName(attributes)})`);
      combos.add(combo);
      const priceMinor = BigInt(v.priceMinor);
      const promoPriceMinor = v.promoPriceMinor == null ? null : BigInt(v.promoPriceMinor);
      if (promoPriceMinor !== null && promoPriceMinor > priceMinor) throw new BadRequestException(`Variant ${i + 1}: promotional price can't be above the regular price`);
      if (creating && v.id) throw new BadRequestException('New products cannot reference existing variant ids');
      return {
        id: v.id, attributes, name: variantName(attributes), sku: v.sku, priceMinor, promoPriceMinor,
        costPriceMinor: v.costPriceMinor == null ? null : BigInt(v.costPriceMinor), initialStock: v.initialStock ?? 0, isActive: v.isActive ?? true,
      };
    });
    if (keySets.size > 1) throw new BadRequestException('All variants must use the same attributes (e.g. every variant has Colour and Size)');
    return out;
  }

  /**
   * Creates/updates variants to match `inputs`. Existing variants left out are deactivated (order history keeps them).
   * New variants get an inventory row; opening stock is booked as a RESTOCK movement.
   */
  async writeVariants(tx: Tx, tenantId: string, product: { id: string; productCode: string }, existing: Array<{ id: string; sku: string }>, inputs: NormalisedVariant[], actorId: string) {
    const existingById = new Map(existing.map((v) => [v.id, v]));
    for (const v of inputs) if (v.id && !existingById.has(v.id)) throw new BadRequestException('Unknown variant for this product');

    // SKUs: explicit ones must be free (outside this product's own variants); generated ones get a suffix if needed.
    const ownIds = new Set(existing.map((v) => v.id));
    const wanted = inputs.map((v) => v.sku ?? skuFor(product.productCode, v.attributes));
    const clash = await tx.productVariant.findMany({ where: { sku: { in: wanted } }, select: { id: true, sku: true } });
    const taken = new Set(clash.filter((c) => !ownIds.has(c.id)).map((c) => c.sku.toLowerCase()));
    const used = new Set<string>();
    const skus = inputs.map((v, i) => {
      const self = v.id ? existingById.get(v.id)!.sku : null;
      let sku = wanted[i];
      if (v.sku) {
        if ((taken.has(sku.toLowerCase()) && sku !== self) || used.has(sku.toLowerCase())) throw new ConflictException(`SKU ${sku} is already used in your store`);
      } else if (!(self && self === sku)) {
        for (let n = 2; taken.has(sku.toLowerCase()) || used.has(sku.toLowerCase()); n++) sku = `${wanted[i]}-${n}`.slice(0, 64);
      }
      used.add(sku.toLowerCase());
      return sku;
    });

    for (const [i, v] of inputs.entries()) {
      const data = {
        sku: skus[i], name: v.name, attributes: v.attributes, priceMinor: v.priceMinor, promoPriceMinor: v.promoPriceMinor,
        costPriceMinor: v.costPriceMinor, isActive: v.isActive, isDefault: i === 0,
      };
      if (v.id) {
        await tx.productVariant.update({ where: { id: v.id }, data });
      } else {
        const created = await tx.productVariant.create({ data: { ...data, productId: product.id } as Prisma.ProductVariantUncheckedCreateInput, select: { id: true } });
        await tx.inventory.create({ data: { variantId: created.id } as Prisma.InventoryUncheckedCreateInput });
        if (v.initialStock > 0) await this.inventory.receiveTx(tx, tenantId, created.id, v.initialStock, 'Opening stock', actorId);
      }
    }
    const keep = new Set(inputs.filter((v) => v.id).map((v) => v.id));
    const drop = existing.filter((v) => !keep.has(v.id)).map((v) => v.id);
    if (drop.length) await tx.productVariant.updateMany({ where: { id: { in: drop } }, data: { isActive: false, isDefault: false } });
  }

  async generateCode(tx: Tx, name: string, categoryName?: string | null) {
    const codes = await tx.product.findMany({ select: { productCode: true } });
    return nextProductCode(codePrefix(name, categoryName), codes.map((c) => c.productCode));
  }

  async uniqueSlug(tx: Tx, base: string) {
    const taken = new Set((await tx.product.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // ───────────────────────── helpers ─────────────────────────

  private async assertCodeFree(tx: Tx, code: string) {
    if (await tx.product.findFirst({ where: { productCode: code }, select: { id: true } })) {
      throw new ConflictException(`Product code ${code} is already used in your store`);
    }
  }

  /** Keeps media already on the product; confirms new uploads (tenant-bound, single use, type-checked). */
  private async confirmMedia(tenantId: string, current: MediaEntry[], incoming: MediaItemDto[]) {
    const currentKeys = new Map((current ?? []).map((m) => [m.key, m]));
    const seen = new Set<string>();
    const added: string[] = [];
    const entries: MediaEntry[] = [];
    try {
      for (const [i, m] of incoming.entries()) {
        if (seen.has(m.key)) throw new BadRequestException('The same file is listed twice');
        seen.add(m.key);
        const kept = currentKeys.get(m.key);
        if (kept) {
          entries.push({ ...kept, alt: m.alt ?? kept.alt, sortOrder: i });
          continue;
        }
        const file = await this.storage.confirmUpload(tenantId, m.type === 'video' ? 'product-video' : 'product-image', m.key);
        added.push(file.key);
        entries.push({ type: m.type, key: file.key, alt: m.alt, sortOrder: i });
      }
    } catch (e) {
      await Promise.all(added.map((k) => this.storage.delete(k)));
      throw e;
    }
    const removed = (current ?? []).map((m) => m.key).filter((k) => !seen.has(k));
    return { entries, added, removed };
  }

  private async shape(p: {
    id: string; name: string; slug: string; productCode: string; description: string | null; status: string; currency: string;
    tags: string[]; media: unknown; weightGrams: number | null; dimensionsMm: unknown; lowStockThreshold: number; createdAt: Date; updatedAt: Date;
    category: { id: string; name: string } | null;
    variants: Array<{ id: string; sku: string; name: string; attributes: unknown; priceMinor: bigint; promoPriceMinor: bigint | null; costPriceMinor: bigint | null; isDefault: boolean; isActive: boolean; inventory: { onHand: number; reserved: number } | null }>;
  }) {
    const media = await Promise.all(((p.media as MediaEntry[]) ?? []).map(async (m) => ({ ...m, url: await this.storage.readUrl(m.key, m.type === 'video' ? 'product-video' : 'product-image') })));
    const variants = p.variants.map((v) => {
      const onHand = v.inventory?.onHand ?? 0;
      const reserved = v.inventory?.reserved ?? 0;
      return { ...v, attributes: v.attributes as Record<string, string>, inventory: { onHand, reserved, available: onHand - reserved } };
    });
    const active = variants.filter((v) => v.isActive);
    const options = new Map<string, Set<string>>();
    for (const v of active) for (const [k, val] of Object.entries(v.attributes)) (options.get(k) ?? options.set(k, new Set()).get(k)!).add(val);
    const prices = active.map((v) => v.promoPriceMinor ?? v.priceMinor);
    const available = active.reduce((s, v) => s + v.inventory.available, 0);
    return {
      ...p, media, variants,
      // jsonb does not keep key order, so option names are sorted for a stable display; values keep variant order.
      options: [...options].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ name, values: [...values] })),
      priceMinMinor: prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : null,
      priceMaxMinor: prices.length ? prices.reduce((a, b) => (a > b ? a : b)) : null,
      stock: { available, lowStock: active.some((v) => v.inventory.available <= p.lowStockThreshold) && available > 0, outOfStock: available <= 0 },
    };
  }
}

export function cleanTags(tags?: string[]) {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
