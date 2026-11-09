/**
 * Pure catalogue helpers: slugs, product codes, SKUs, money parsing, CSV. No database, no floats.
 */

export function slugify(input: string, max = 80): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'item';
}

export const PRODUCT_CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/** Letters-only prefix for generated codes: the category's first word, else the product name's last word. */
export function codePrefix(productName: string, categoryName?: string | null): string {
  const words = (s: string) => s.normalize('NFKD').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  const fromCategory = categoryName ? words(categoryName)[0] : undefined;
  const nameWords = words(productName);
  const pick = fromCategory ?? nameWords[nameWords.length - 1] ?? 'ITEM';
  return pick.slice(0, 5);
}

/**
 * Next code like BAG001: the prefix plus one more than the highest number used by any code in the store, so codes
 * announced in live sessions never repeat a number (BAG001, SHOE002, DRESS003 …).
 */
export function nextProductCode(prefix: string, existingCodes: string[]): string {
  let max = 0;
  for (const c of existingCodes) {
    const m = /(\d+)$/.exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

/** "Black / L" from { Colour: "Black", Size: "L" }; "Default" for a simple product. */
export function variantName(attributes: Record<string, string>): string {
  const v = Object.values(attributes).map((x) => x.trim()).filter(Boolean);
  return v.length ? v.join(' / ') : 'Default';
}

/** BAG001-BLAC-L: product code plus up to 4 letters/digits of each attribute value. */
export function skuFor(productCode: string, attributes: Record<string, string>): string {
  const parts = Object.values(attributes)
    .map((v) => v.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))
    .filter(Boolean);
  return [productCode, ...parts].join('-').slice(0, 64);
}

/** "25,000.50" / "₦25000" / "25000.5" → 2500050n kobo. Strings only — never parsed as a float. */
export function parseNairaToKobo(input: string): bigint {
  const s = input.trim().replace(/^₦/, '').replace(/,/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount "${input}"`);
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export function koboToNaira(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** "Colour=Black; Size=L" ⇄ { Colour: "Black", Size: "L" }. */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(';')) {
    if (!part.trim()) continue;
    const i = part.indexOf('=');
    if (i <= 0) throw new Error(`Attribute "${part.trim()}" must look like Name=Value`);
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || !v) throw new Error(`Attribute "${part.trim()}" must look like Name=Value`);
    out[k] = v;
  }
  return out;
}

export function formatAttributes(a: Record<string, string>): string {
  return Object.entries(a).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── CSV (RFC 4180) ──

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * One CSV cell. Values a spreadsheet would execute as a formula (=, +, -, @, tab, CR) are prefixed with an
 * apostrophe — CSV exports are opened in Excel/Sheets by sellers, so this blocks formula injection.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
