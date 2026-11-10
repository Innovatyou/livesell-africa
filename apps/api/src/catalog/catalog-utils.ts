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
/**
 * Short code prefix from what the product *is*: "Red Leather Handbag" → BAG, "Ladies Block Heels Size 39" → HEEL,
 * "Set of 3 Wigs" → WIG, "Vitamin C Face Serum" → SERUM. Picks the head noun (skipping colours, sizes, materials and
 * marketing words), maps common items to familiar codes, else uses the noun's first 5 letters; the category only when
 * the name says nothing usable. Sellers can always type their own code.
 */
export function codePrefix(productName: string, categoryName?: string | null): string {
  const words = (s: string) =>
    s.normalize('NFKD').toUpperCase().replace(/\p{M}/gu, '').replace(/['’]S\b/g, '').replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  const fromName = headNoun(words(productName));
  if (fromName) return fromName;
  const fromCategory = headNoun(words(categoryName ?? ''));
  return fromCategory ?? 'ITEM';
}

const singular = (w: string) => (w.length > 4 && /(SS|US|IS)$/.test(w) ? w : w.replace(/(CH|SH|SS|X)ES$/, '$1').replace(/IES$/, 'Y').replace(/([^S])S$/, '$1'));

/** Common things Nigerian social sellers list, mapped to the codes they already say on live. */
const KNOWN: Record<string, string> = {
  BAG: 'BAG', HANDBAG: 'BAG', PURSE: 'BAG', TOTE: 'TOTE', BACKPACK: 'BPACK', CLUTCH: 'CLTCH', WALLET: 'WALLT',
  SHOE: 'SHOE', SNEAKER: 'SNEAK', TRAINER: 'SNEAK', HEEL: 'HEEL', SANDAL: 'SANDL', SLIPPER: 'SLIP', SLIDE: 'SLIDE', BOOT: 'BOOT', LOAFER: 'LOAFR', PALM: 'PALM',
  DRESS: 'DRESS', GOWN: 'GOWN', ABAYA: 'ABAYA', KAFTAN: 'KFTAN', BUBU: 'BUBU', AGBADA: 'AGBDA', SENATOR: 'SNATR', JUMPSUIT: 'JUMP', SKIRT: 'SKIRT',
  TOP: 'TOP', BLOUSE: 'BLOUS', SHIRT: 'SHIRT', TSHIRT: 'TEE', TEE: 'TEE', POLO: 'POLO', HOODIE: 'HOODY', JACKET: 'JCKT', TROUSER: 'TROUS', PANT: 'PANTS',
  JEAN: 'JEANS', SHORT: 'SHORT', JOGGER: 'JOGGR', BRA: 'BRA', LINGERIE: 'LINGR', BOXER: 'BOXER', PYJAMA: 'PJS', NIGHTWEAR: 'NIGHT',
  WIG: 'WIG', BUNDLE: 'HAIR', HAIR: 'HAIR', FRONTAL: 'FRONT', CLOSURE: 'CLOSE', LACE: 'LACE', BRAID: 'BRAID',
  WATCH: 'WATCH', RING: 'RING', EARRING: 'EAR', NECKLACE: 'NECK', CHAIN: 'CHAIN', BRACELET: 'BRACE', ANKLET: 'ANKLT', SUNGLASSE: 'SHADE', GLASSE: 'GLASS', CAP: 'CAP', HAT: 'HAT', BELT: 'BELT', SCARF: 'SCARF',
  PERFUME: 'PERF', FRAGRANCE: 'PERF', OIL: 'OIL', CREAM: 'CREAM', LOTION: 'LOTN', SERUM: 'SERUM', SOAP: 'SOAP', SCRUB: 'SCRUB', LIPSTICK: 'LIP', LIPGLOSS: 'GLOSS', GLOS: 'GLOSS',
  FOUNDATION: 'FOUND', POWDER: 'POWDR', LASH: 'LASH', NAIL: 'NAIL', SPRAY: 'SPRAY', SHAMPOO: 'SHAMP', CONDITIONER: 'COND',
  PHONE: 'PHONE', CASE: 'CASE', CHARGER: 'CHRGR', EARBUD: 'BUDS', EARPHONE: 'BUDS', HEADPHONE: 'HEAD', SPEAKER: 'SPKR', POWERBANK: 'PBANK', LAPTOP: 'LAPTP', TABLET: 'TAB', CABLE: 'CABLE',
  BLENDER: 'BLEND', POT: 'POT', PLATE: 'PLATE', CUP: 'CUP', FLASK: 'FLASK', BEDSHEET: 'SHEET', DUVET: 'DUVET', PILLOW: 'PILLW', CURTAIN: 'CURTN', RUG: 'RUG',
  FABRIC: 'FABRC', ANKARA: 'ANKRA', ASOEBI: 'ASOEB', AGBADA_: 'AGBDA', TOY: 'TOY', DIAPER: 'DIAPR', SNACK: 'SNACK', DRINK: 'DRINK', TEA: 'TEA', HONEY: 'HONEY',
};

/** Words that describe a product rather than name it. */
const MODIFIERS = new Set(('RED BLACK WHITE BLUE GREEN PINK PURPLE BROWN GOLD GOLDEN SILVER GREY GRAY BEIGE NAVY YELLOW ORANGE NUDE CREAMY MULTI COLOUR COLOR ' +
  'XS XL XXL XXXL SMALL MEDIUM LARGE BIG MINI MAXI MIDI SIZE INCH INCHES CM ML GRAM KG LITRE LITER PIECE PCS PC ' +
  'NEW ORIGINAL QUALITY PREMIUM CLASSIC LUXURY LUXURIOUS UNISEX MEN MENS WOMEN WOMENS LADIES LADY KIDS KID BOYS GIRLS BABY FEMALE MALE PLAIN ' +
  'LEATHER SUEDE COTTON SILK LINEN DENIM WOOL VELVET SATIN CHIFFON GENUINE FAUX HUMAN BRAZILIAN PERUVIAN STRAIGHT CURLY WAVY BODY DEEP ' +
  'HOT SALE OFFER DEAL BEST TOP_ FASHION FASHIONABLE STYLISH TRENDY ELEGANT CUTE SEXY QUALITY AND THE WITH FOR OF IN BY FROM NEW_ ' +
  'SET PACK PAIR PAIRS BOX COMBO BUNDLE_ DOZEN').split(/\s+/));
const CONTAINERS = new Set(['SET', 'PACK', 'PAIR', 'PAIRS', 'BOX', 'COMBO', 'DOZEN']);

function headNoun(all: string[]): string | null {
  if (!all.length) return null;
  // "Bag with strap" → before the preposition; "Set of 3 wigs" → after it (the set is the container, not the thing).
  const cut = all.findIndex((w) => ['WITH', 'FOR', 'OF', 'IN', 'BY', 'FROM'].includes(w));
  let part = cut > 0 ? all.slice(0, cut) : all;
  if (cut > 0 && part.every((w) => CONTAINERS.has(w) || MODIFIERS.has(w))) part = all.slice(cut + 1);
  const nouns = part.map(singular).filter((w) => !MODIFIERS.has(w) && !MODIFIERS.has(w + 'S'));
  if (!nouns.length) return null;
  for (let i = nouns.length - 1; i >= 0; i--) if (KNOWN[nouns[i]]) return KNOWN[nouns[i]];
  return nouns[nouns.length - 1].slice(0, 5);
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
