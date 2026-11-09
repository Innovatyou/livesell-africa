/**
 * Money arrives from the API as minor units (kobo) in a string. It is formatted with BigInt only —
 * never converted to a floating-point number.
 */
const SYMBOLS: Record<string, string> = { NGN: '₦', USD: '$', GHS: 'GH₵', KES: 'KSh', ZAR: 'R' };

export function toMinor(value: string | bigint | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('Minor units must be integers');
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid minor-unit amount: ${value}`);
  return BigInt(value);
}

const group = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** ₦25,000 · ₦25,000.50 · −₦1,200. `decimals: 'auto'` shows kobo only when non-zero. */
export function formatMoney(value: string | bigint | number | null | undefined, currency = 'NGN', opts: { decimals?: 'auto' | 'always' | 'never' } = {}): string {
  const minor = toMinor(value);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const decimals = opts.decimals ?? 'auto';
  const showFrac = decimals === 'always' || (decimals === 'auto' && frac !== 0n);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${neg ? '−' : ''}${symbol}${group(whole)}${showFrac ? `.${frac.toString().padStart(2, '0')}` : ''}`;
}

/** Compact axis/tile labels: ₦950, ₦12.5K, ₦3.2M, ₦1.1B (one decimal, truncated, never rounded up). */
export function formatMoneyCompact(value: string | bigint | number | null | undefined, currency = 'NGN'): string {
  const whole = toMinor(value) / 100n;
  const neg = whole < 0n;
  const abs = neg ? -whole : whole;
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const units: Array<[bigint, string]> = [[1_000_000_000n, 'B'], [1_000_000n, 'M'], [1_000n, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const tenths = (abs * 10n) / size;
      const int = tenths / 10n;
      const dec = tenths % 10n;
      return `${neg ? '−' : ''}${symbol}${group(int)}${dec ? `.${dec}` : ''}${suffix}`;
    }
  }
  return `${neg ? '−' : ''}${symbol}${group(abs)}`;
}

export function formatCount(n: number | string | bigint): string {
  return group(BigInt(n));
}

/** Basis points as a percentage without floats: 300 → "3%", 250 → "2.5%", 275 → "2.75%". */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new Error('Invalid basis points');
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/** What a seller types ("25,000", "₦25000.5") → kobo string ("2500050"), or null if it isn't a valid amount. */
export function nairaToKobo(input: string): string | null {
  const s = input.trim().replace(/^₦/, '').replace(/[,\s]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return (BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')).toString();
}

/** Kobo string → plain editable naira text ("2500050" → "25000.50", "2500000" → "25000"). */
export function koboToNairaInput(minor: string | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const v = toMinor(minor);
  const frac = v % 100n;
  return frac === 0n ? (v / 100n).toString() : `${v / 100n}.${frac.toString().padStart(2, '0')}`;
}
