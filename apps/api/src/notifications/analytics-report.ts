import { escapeHtml } from './html';

/**
 * Scheduled analytics email (advanced plans, Phase 10b). Pure. Figures arrive as strings/numbers (kobo strings for
 * money, basis points for rates) so a retried message renders exactly the same.
 */
export interface ReportEmailVars {
  storeName: string;
  frequency: 'WEEKLY' | 'MONTHLY';
  periodLabel: string; // "Week of 2 Nov 2026" / "October 2026"
  from: string; // YYYY-MM-DD
  to: string;
  currency: string;
  grossSalesMinor: string; previousGrossSalesMinor: string;
  netSalesMinor: string; refundsMinor: string;
  orders: number; previousOrders: number; paidOrders: number;
  averageOrderValueMinor: string; paymentCompletionBps: number | null;
  newCustomers: number; liveSessions: number;
  topProduct: { name: string; productCode: string; unitsSold: number } | null;
  bestChannel: { name: string; grossSalesMinor: string } | null;
}

const money = (minor: string | bigint, currency: string) => {
  const v = BigInt(minor);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${currency === 'NGN' ? '₦' : `${currency} `}${whole}${frac === '00' ? '' : `.${frac}`}`;
};
const rate = (b: number | null) => (b === null ? '—' : `${(b / 100).toFixed(1)}%`);
/** "+25.0% vs the period before" / "first sales" / "same as the period before". */
export function vsPrevious(current: string | number, previous: string | number): string {
  const c = BigInt(current);
  const p = BigInt(previous);
  if (c === p) return 'same as the period before';
  if (p === 0n) return 'up from nothing the period before';
  const bps = Number(((c - p) * 10_000n) / p);
  return `${bps > 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(1)}% vs the period before`;
}

export function analyticsReportEmail(raw: Record<string, unknown>, appUrl: string) {
  const v = raw as unknown as ReportEmailVars;
  const cur = v.currency || 'NGN';
  const link = `${appUrl}/analytics?from=${encodeURIComponent(v.from)}&to=${encodeURIComponent(v.to)}`;
  const row = (label: string, value: string, note = '') =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eef0ef;color:#5b6560">${escapeHtml(label)}</td><td style="padding:8px 0;border-bottom:1px solid #eef0ef;text-align:right;font-weight:600">${escapeHtml(value)}${note ? `<br><span style="font-weight:400;color:#98a19c;font-size:12px">${escapeHtml(note)}</span>` : ''}</td></tr>`;
  const rows = [
    row('Gross sales', money(v.grossSalesMinor, cur), vsPrevious(v.grossSalesMinor, v.previousGrossSalesMinor)),
    row('Net sales (after refunds)', money(v.netSalesMinor, cur), BigInt(v.refundsMinor) > 0n ? `${money(v.refundsMinor, cur)} refunded` : ''),
    row('Orders', String(v.orders), `${v.paidOrders} paid · ${vsPrevious(v.orders, v.previousOrders)}`),
    row('Average order value', money(v.averageOrderValueMinor, cur)),
    row('Payment completion', rate(v.paymentCompletionBps)),
    row('New customers', String(v.newCustomers)),
    row('Live sessions', String(v.liveSessions)),
    ...(v.topProduct ? [row('Top product', `${v.topProduct.productCode} ${v.topProduct.name}`, `${v.topProduct.unitsSold} sold`)] : []),
    ...(v.bestChannel ? [row('Best channel', v.bestChannel.name, money(v.bestChannel.grossSalesMinor, cur))] : []),
  ].join('');
  const title = `${v.frequency === 'WEEKLY' ? 'Weekly' : 'Monthly'} report — ${v.periodLabel}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#17201b">
<table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px"><tr><td>
<p style="font-weight:700;color:#0e7a4d;margin:0 0 4px">${escapeHtml(v.storeName)}</p>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">${rows}</table>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0e7a4d;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Open the full report</a></p>
<p style="color:#98a19c;font-size:12px">Paid means the payment was verified. Figures are by the day orders were placed (Africa/Lagos). You get this because you are on your store's report list; change it in Analytics → Email reports.</p>
</td></tr></table></td></tr></table></body></html>`;
  return {
    subject: `${v.storeName}: ${title}`,
    html,
    text: `${v.storeName} ${title}: gross ${money(v.grossSalesMinor, cur)} (${vsPrevious(v.grossSalesMinor, v.previousGrossSalesMinor)}), ${v.orders} orders, ${v.paidOrders} paid. ${link}`,
  };
}
