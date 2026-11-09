/**
 * Exact conversion between our BIGINT minor units (kobo) and the decimal major-unit amounts some providers use
 * (Flutterwave: JSON numbers in naira; Bachs: decimal strings such as "2500.00"). No floating-point arithmetic:
 * values are handled as digit strings.
 */
export class DecimalAmountError extends Error {}

/** 250050n → "2500.50" (always `scale` decimals). */
export function minorToDecimal(minor: bigint, scale = 2): string {
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(scale + 1, '0');
  const whole = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${neg ? '-' : ''}${whole}${scale ? `.${frac}` : ''}`;
}

/**
 * "2500.5" | 2500.5 | "2500" → 250050n. `exact` (default) refuses more than `scale` decimals — use it for amounts
 * that decide whether an order is paid. `round: true` rounds half-up instead — for fees, which can carry VAT digits.
 */
export function decimalToMinor(value: string | number, opts: { scale?: number; round?: boolean } = {}): bigint {
  const scale = opts.scale ?? 2;
  let s = typeof value === 'number' ? numberToPlain(value) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new DecimalAmountError(`Not a decimal amount: ${String(value).slice(0, 40)}`);
  const [, sign, whole, fracRaw = ''] = m;
  let frac = fracRaw;
  let carry = 0n;
  if (frac.length > scale) {
    if (!opts.round && /[1-9]/.test(frac.slice(scale))) throw new DecimalAmountError(`More than ${scale} decimals: ${s}`);
    carry = Number(frac[scale]) >= 5 && opts.round ? 1n : 0n;
    frac = frac.slice(0, scale);
  }
  s = `${whole}${frac.padEnd(scale, '0')}`;
  const out = BigInt(s) + carry;
  return sign ? -out : out;
}

/** JSON numbers like 1.4 or 2500 → "1.4" / "2500" without exponent notation. */
function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new DecimalAmountError('Amount is not a finite number');
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(Math.min(20, Math.max(0, -Math.floor(Math.log10(Math.abs(n))) + 2)));
}
