/** Display helpers (pure, tested). Money is kobo strings from the API; never floats. */

export function money(minor: string | bigint | number | null | undefined, currency = 'NGN'): string {
  const v = BigInt(minor ?? 0);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${currency === 'NGN' ? '₦' : `${currency} `}${whole}${frac === '00' ? '' : `.${frac}`}`;
}

/** What a seller types ("25,000", "₦25000.5") → kobo string, or null if it isn't an amount. */
export function toKobo(input: string): string | null {
  const t = input.replace(/[₦,\s]/g, '');
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w) * 100n + BigInt((f + '00').slice(0, 2))).toString();
}

/** Nigerian numbers typed locally ("0803 123 4567") → E.164. */
export function e164(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  if (/^0\d{10}$/.test(d)) return `+234${d.slice(1)}`;
  if (/^234\d{10}$/.test(d)) return `+${d}`;
  return d;
}
export const isE164 = (v: string) => /^\+[1-9]\d{7,14}$/.test(v);

export const when = (iso: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'warn' }, PAYMENT_VERIFICATION: { label: 'Verifying payment', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'good' }, PROCESSING: { label: 'Processing', tone: 'info' }, READY_FOR_DISPATCH: { label: 'Ready to dispatch', tone: 'info' },
  DISPATCHED: { label: 'Dispatched', tone: 'info' }, DELIVERED: { label: 'Delivered', tone: 'good' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REFUNDED: { label: 'Refunded', tone: 'bad' }, PARTIALLY_REFUNDED: { label: 'Partly refunded', tone: 'bad' },
};
export const ACTION_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Confirm order', PROCESSING: 'Start processing', READY_FOR_DISPATCH: 'Mark ready', DISPATCHED: 'Mark dispatched', DELIVERED: 'Mark delivered', CANCELLED: 'Cancel order',
};
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

/** "stock held 3h 20m more" / "hold expired" / null. */
export function holdLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'hold expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `stock held ${Math.floor(h / 24)}d ${h % 24}h more` : `stock held ${h}h ${m}m more`;
}
