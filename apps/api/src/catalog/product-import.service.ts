import { BadRequestException, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service';
import { AuditService } from '../common/audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRODUCT_CODE, formatAttributes, koboToNaira, normaliseCode, parseAttributes, parseCsv, parseNairaToKobo, slugify, toCsv, variantName,
} from './catalog-utils';
import { CategoriesService } from './categories.service';
import { cleanTags, ProductsService } from './products.service';

export const CSV_COLUMNS = [
  'product_code', 'name', 'description', 'category', 'status', 'tags', 'attributes', 'sku',
  'price', 'promo_price', 'cost_price', 'stock', 'active', 'weight_grams', 'low_stock_threshold',
] as const;
type Col = (typeof CSV_COLUMNS)[number];
const MAX_ROWS = 1000;
const STATUSES = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED']);
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RowVariant { row: number; sku?: string; attributes: Record<string, string>; price: bigint; promo: bigint | null; cost: bigint | null; stock: number | null; active: boolean | null }
interface Group {
  key: string; code?: string; firstRow: number;
  product: { name?: string; description?: string; category?: string; status?: string; tags?: string[]; weight?: number; threshold?: number };
  variants: RowVariant[];
}
export interface ImportSummary { dryRun: boolean; rows: number; productsCreated: number; productsUpdated: number; variantsCreated: number; variantsUpdated: number }

/**
 * CSV import/export (MASTER-SPEC §8). One row per variant; rows with the same product_code (or, when blank, the
 * same name) form one product. Import validates everything first and is all-or-nothing in one transaction.
 * Existing products are matched by product_code, existing variants by SKU or attributes; nothing is deleted.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly inventory: InventoryService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  async exportCsv(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId).product.findMany({
      where: { deletedAt: null }, orderBy: { createdAt: 'asc' },
      include: { category: { select: { name: true } }, variants: { orderBy: { createdAt: 'asc' }, include: { inventory: true } } },
    });
    const out: unknown[][] = [];
    for (const p of rows) {
      for (const v of p.variants) {
        out.push([
          p.productCode, p.name, p.description ?? '', p.category?.name ?? '', p.status, p.tags.join('; '),
          formatAttributes(v.attributes as Record<string, string>), v.sku, koboToNaira(v.priceMinor),
          v.promoPriceMinor === null ? '' : koboToNaira(v.promoPriceMinor), v.costPriceMinor === null ? '' : koboToNaira(v.costPriceMinor),
          v.inventory?.onHand ?? 0, v.isActive ? 'yes' : 'no', p.weightGrams ?? '', p.lowStockThreshold,
        ]);
      }
    }
    return toCsv([...CSV_COLUMNS], out);
  }

  async importCsv(tenantId: string, actorId: string, csv: string, dryRun: boolean): Promise<ImportSummary> {
    const groups = this.parse(csv);
    const db = this.prisma.forTenant(tenantId);
    const codes = groups.map((g) => g.code).filter((c): c is string => !!c);
    const existing = await db.product.findMany({
      where: { productCode: { in: codes } }, include: { variants: { include: { inventory: true } } },
    });
    const byCode = new Map(existing.map((p) => [p.productCode, p]));
    const errors: Array<{ row: number; message: string }> = [];
    const summary: ImportSummary = { dryRun, rows: groups.reduce((n, g) => n + g.variants.length, 0), productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0 };

    for (const g of groups) {
      const p = g.code ? byCode.get(g.code) : undefined;
      if (p?.deletedAt) { errors.push({ row: g.firstRow, message: `Product code ${g.code} belongs to a deleted product` }); continue; }
      if (!p && !g.product.name) { errors.push({ row: g.firstRow, message: 'name is required for a new product' }); continue; }
      if (p) summary.productsUpdated++; else summary.productsCreated++;
      const keyset = new Set<string>();
      const ownKeys = p?.variants[0] ? Object.keys(p.variants[0].attributes as object).map((k) => k.toLowerCase()).sort().join('|') : null;
      for (const v of g.variants) {
        const keys = Object.keys(v.attributes).map((k) => k.toLowerCase()).sort().join('|');
        keyset.add(keys);
        if (ownKeys !== null && keys !== ownKeys) errors.push({ row: v.row, message: `attributes must use the same names as the product's existing variants (${ownKeys.replace(/\|/g, ', ') || 'none'})` });
        const match = p && findVariant(p.variants, v);
        if (match) summary.variantsUpdated++; else summary.variantsCreated++;
        if (match && v.stock !== null && v.stock < (match.inventory?.reserved ?? 0)) {
          errors.push({ row: v.row, message: `stock can't be below ${match.inventory?.reserved} (reserved for open orders)` });
        }
      }
      if (keyset.size > 1) errors.push({ row: g.firstRow, message: 'all variants of a product must use the same attribute names' });
    }

    // SKUs must not belong to a different product in the store.
    const skus = groups.flatMap((g) => g.variants.map((v) => v.sku).filter((s): s is string => !!s));
    if (skus.length) {
      const owners = await db.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true, product: { select: { productCode: true } } } });
      const ownerBySku = new Map(owners.map((o) => [o.sku.toLowerCase(), o.product.productCode]));
      for (const g of groups) for (const v of g.variants) {
        const owner = v.sku ? ownerBySku.get(v.sku.toLowerCase()) : undefined;
        if (owner && owner !== g.code) errors.push({ row: v.row, message: `SKU ${v.sku} already belongs to product ${owner}` });
      }
    }
    if (errors.length) throw new BadRequestException({ code: 'IMPORT_INVALID', message: `${errors.length} problem(s) found; nothing was imported`, errors: errors.sort((a, b) => a.row - b.row).slice(0, 200) });
    if (summary.productsCreated) await this.entitlements.assertCanAdd(tenantId, 'products', summary.productsCreated);
    if (dryRun) return summary;

    await this.prisma.tenantTransaction(tenantId, async (tx) => {
      for (const g of groups) {
        const current = g.code ? byCode.get(g.code) : undefined;
        const category = g.product.category ? await this.categories.findOrCreateByName(tx, tenantId, g.product.category) : undefined;
        let product: { id: string; productCode: string };
        if (current) {
          product = current;
          await tx.product.update({
            where: { id: current.id },
            data: {
              name: g.product.name, description: g.product.description, categoryId: category?.id, tags: g.product.tags,
              weightGrams: g.product.weight, lowStockThreshold: g.product.threshold,
              status: g.product.status as Prisma.ProductUpdateInput['status'],
            },
          });
        } else {
          const productCode = g.code ?? (await this.products.generateCode(tx, g.product.name!, category?.name));
          product = await tx.product.create({
            data: {
              name: g.product.name!, slug: await this.products.uniqueSlug(tx, slugify(g.product.name!)), productCode,
              description: g.product.description ?? null, categoryId: category?.id ?? null, tags: g.product.tags ?? [],
              status: (g.product.status ?? 'DRAFT') as 'DRAFT', weightGrams: g.product.weight ?? null, lowStockThreshold: g.product.threshold ?? 5,
            } as Prisma.ProductUncheckedCreateInput,
            select: { id: true, productCode: true },
          });
        }
        // Full variant list = existing variants (unchanged unless a row updates them) + new rows.
        const own = current?.variants ?? [];
        const touched = new Map<string, RowVariant>();
        const fresh: RowVariant[] = [];
        for (const v of g.variants) {
          const m = findVariant(own, v);
          if (m) touched.set(m.id, v); else fresh.push(v);
        }
        const list = [
          ...own.map((e) => {
            const r = touched.get(e.id);
            return {
              id: e.id, attributes: e.attributes as Record<string, string>, name: variantName(e.attributes as Record<string, string>),
              sku: r?.sku ?? e.sku, priceMinor: r?.price ?? e.priceMinor, promoPriceMinor: r ? r.promo : e.promoPriceMinor,
              costPriceMinor: r ? r.cost : e.costPriceMinor, initialStock: 0, isActive: r?.active ?? e.isActive,
            };
          }),
          ...fresh.map((v) => ({
            attributes: v.attributes, name: variantName(v.attributes), sku: v.sku, priceMinor: v.price, promoPriceMinor: v.promo,
            costPriceMinor: v.cost, initialStock: v.stock ?? 0, isActive: v.active ?? true,
          })),
        ];
        await this.products.writeVariants(tx, tenantId, product, own, list, actorId);
        for (const [variantId, v] of touched) {
          if (v.stock !== null) await this.inventory.setOnHandTx(tx, tenantId, variantId, v.stock, 'CSV import', actorId);
        }
      }
    });
    await this.audit.record({ action: 'product.imported', actorId, tenantId, entityType: 'product', metadata: { ...summary } });
    return summary;
  }

  /** CSV → product groups, with per-row validation errors collected (row numbers match the spreadsheet). */
  private parse(csv: string): Group[] {
    let rows: string[][];
    try {
      rows = parseCsv(csv);
    } catch (e) {
      throw new BadRequestException({ code: 'IMPORT_INVALID', message: `The file isn't valid CSV: ${(e as Error).message}`, errors: [] });
    }
    if (rows.length < 2) throw new BadRequestException({ code: 'IMPORT_INVALID', message: 'The file has no data rows', errors: [] });
    if (rows.length - 1 > MAX_ROWS) throw new BadRequestException({ code: 'IMPORT_INVALID', message: `At most ${MAX_ROWS} rows per import`, errors: [] });

    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const idx = new Map<string, number>(header.map((h, i) => [h, i]));
    const missing = (['name', 'price'] as Col[]).filter((c) => !idx.has(c));
    if (missing.length) throw new BadRequestException({ code: 'IMPORT_INVALID', message: `Missing column(s): ${missing.join(', ')}`, errors: [] });

    const errors: Array<{ row: number; message: string }> = [];
    const groups = new Map<string, Group>();
    rows.slice(1).forEach((cells, i) => {
      const rowNo = i + 2;
      const cell = (c: Col) => (idx.has(c) ? (cells[idx.get(c)!] ?? '').trim() : '');
      const fail = (m: string) => errors.push({ row: rowNo, message: m });
      const money = (c: Col, required: boolean) => {
        const v = cell(c);
        if (!v) { if (required) fail(`${c} is required`); return null; }
        try { return parseNairaToKobo(v); } catch { fail(`${c} "${v}" is not a valid naira amount (e.g. 25000 or 25,000.50)`); return null; }
      };
      const int = (c: Col) => {
        const v = cell(c);
        if (!v) return null;
        if (!/^\d{1,7}$/.test(v)) { fail(`${c} must be a whole number`); return null; }
        return Number(v);
      };

      const code = cell('product_code') ? normaliseCode(cell('product_code')) : undefined;
      if (code && !PRODUCT_CODE.test(code)) fail(`product_code "${code}" must be 2–20 letters, digits or hyphens`);
      const name = cell('name');
      if (name && (name.length < 2 || name.length > 160)) fail('name must be 2–160 characters');
      const status = cell('status').toUpperCase();
      if (status && !STATUSES.has(status)) fail('status must be DRAFT, ACTIVE or ARCHIVED');
      const sku = cell('sku') || undefined;
      if (sku && !SKU.test(sku)) fail(`sku "${sku}" may contain letters, digits, . _ - (max 64)`);
      let attributes: Record<string, string> = {};
      try { attributes = parseAttributes(cell('attributes')); } catch (e) { fail((e as Error).message); }
      const price = money('price', true);
      const promo = money('promo_price', false);
      const cost = money('cost_price', false);
      if (price !== null && promo !== null && promo > price) fail('promo_price cannot be above price');
      const activeCell = cell('active').toLowerCase();
      if (activeCell && !['yes', 'no', 'true', 'false', '1', '0'].includes(activeCell)) fail('active must be yes or no');

      const key = code ?? (name ? `name:${name.toLowerCase()}` : `row:${rowNo}`);
      const g = groups.get(key) ?? { key, code, firstRow: rowNo, product: {}, variants: [] };
      // Product-level cells: the first non-empty value in the group wins.
      g.product.name ??= name || undefined;
      g.product.description ??= cell('description') || undefined;
      g.product.category ??= cell('category') || undefined;
      g.product.status ??= status || undefined;
      g.product.tags ??= cell('tags') ? cleanTags(cell('tags').split(';')) : undefined;
      g.product.weight ??= int('weight_grams') ?? undefined;
      g.product.threshold ??= int('low_stock_threshold') ?? undefined;
      g.variants.push({
        row: rowNo, sku, attributes, price: price ?? 0n, promo, cost, stock: int('stock'),
        active: activeCell ? ['yes', 'true', '1'].includes(activeCell) : null,
      });
      groups.set(key, g);
    });

    for (const g of groups.values()) {
      const combos = new Set<string>();
      for (const v of g.variants) {
        const c = Object.entries(v.attributes).map(([k, val]) => `${k.toLowerCase()}=${val.toLowerCase()}`).sort().join('|');
        if (combos.has(c)) errors.push({ row: v.row, message: `duplicate variant (${variantName(v.attributes)}) for this product` });
        combos.add(c);
      }
    }
    if (errors.length) throw new BadRequestException({ code: 'IMPORT_INVALID', message: `${errors.length} problem(s) found; nothing was imported`, errors: errors.slice(0, 200) });
    return [...groups.values()];
  }
}

function findVariant<T extends { id: string; sku: string; attributes: unknown }>(variants: T[], v: RowVariant): T | undefined {
  if (v.sku) {
    const bySku = variants.find((e) => e.sku.toLowerCase() === v.sku!.toLowerCase());
    if (bySku) return bySku;
  }
  const want = Object.entries(v.attributes).map(([k, val]) => `${k.toLowerCase()}=${val.toLowerCase()}`).sort().join('|');
  return variants.find((e) => Object.entries(e.attributes as Record<string, string>).map(([k, val]) => `${k.toLowerCase()}=${String(val).toLowerCase()}`).sort().join('|') === want);
}
