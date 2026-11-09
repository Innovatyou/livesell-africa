import PDFDocument from 'pdfkit';
import { koboToNaira, toCsv } from '../catalog/catalog-utils';
import { money, pct } from './analytics-math';
import type { AnalyticsService } from './analytics.service';

export type Report = Awaited<ReturnType<AnalyticsService['report']>>;
export const CSV_REPORTS = ['summary', 'daily', 'channels', 'sessions', 'products', 'patterns', 'customers'] as const;
/** Tables only the advanced tier has. */
export const ADVANCED_CSV: readonly CsvReport[] = ['patterns', 'customers'];
export type CsvReport = (typeof CSV_REPORTS)[number];

const rate = (b: number | null) => (b === null ? '' : (b / 100).toFixed(2));
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** One CSV per table. Amounts in naira with two decimals; rates in percent; no customer personal data. */
export function reportCsv(r: Report, kind: CsvReport): string {
  const o = r.overview;
  switch (kind) {
    case 'summary':
      return toCsv(['metric', 'value', 'previous_period'], [
        ['period', `${r.range.from} to ${r.range.to}`, `${r.previousRange.from} to ${r.previousRange.to}`],
        ['channel', r.channel?.name ?? 'All channels', ''],
        ['currency', r.currency, ''],
        ['orders', o.orders, r.comparison.orders.previous],
        ['paid_orders', o.paidOrders, r.comparison.paidOrders.previous],
        ['awaiting_payment', o.awaitingPayment, ''],
        ['cancelled_orders', o.cancelledOrders, ''],
        ['gross_sales', koboToNaira(o.grossSalesMinor), koboToNaira(r.comparison.grossSalesMinor.previous as bigint)],
        ['refunds', koboToNaira(o.refundsMinor), ''],
        ['net_sales', koboToNaira(o.netSalesMinor), koboToNaira(r.comparison.netSalesMinor.previous as bigint)],
        ['average_order_value', koboToNaira(o.averageOrderValueMinor), koboToNaira(r.comparison.averageOrderValueMinor.previous as bigint)],
        ['units_sold', o.unitsSold, r.comparison.unitsSold.previous],
        ['payment_completion_pct', rate(o.paymentCompletionBps), rate(r.comparison.paymentCompletionBps.previous)],
        ['cancellation_pct', rate(o.cancellationBps), rate(r.comparison.cancellationBps.previous)],
        ['live_sessions', o.liveSessions, ''],
        ['orders_from_live', o.liveOrders, ''],
        ['buyers', o.buyers, ''],
        ['new_customers', o.newCustomers, r.comparison.newCustomers.previous],
        ['repeat_buyers', o.repeatBuyers, ''],
        ['repeat_purchase_pct', rate(o.repeatPurchaseBps), ''],
      ]);
    case 'daily':
      return toCsv([r.range.bucket === 'day' ? 'date' : `${r.range.bucket}_starting`, 'orders', 'paid_orders', 'gross_sales'],
        r.series.map((p) => [p.label, p.orders, p.paidOrders, koboToNaira(p.grossSalesMinor)]));
    case 'channels':
      return toCsv(['channel', 'type', 'orders', 'paid_orders', 'cancelled_orders', 'gross_sales', 'average_order_value', 'payment_completion_pct', 'cancellation_pct', 'new_customers'],
        r.channels.map((c) => [c.name, c.type ?? '', c.orders, c.paidOrders, c.cancelledOrders, koboToNaira(c.grossSalesMinor), koboToNaira(c.averageOrderValueMinor), rate(c.paymentCompletionBps), rate(c.cancellationBps), c.newCustomers]));
    case 'sessions':
      return toCsv(['session', 'channel', 'started_at', 'duration_minutes', 'orders', 'paid_orders', 'cancelled_orders', 'gross_sales', 'units_sold', 'average_order_value', 'payment_completion_pct', 'buyers', 'peak_viewers', 'viewer_data', 'conversion_pct'],
        r.sessions.map((s) => [s.title, s.channel, s.startedAt.toISOString(), s.durationMinutes ?? '', s.orders, s.paidOrders, s.cancelledOrders, koboToNaira(s.grossSalesMinor), s.unitsSold, koboToNaira(s.averageOrderValueMinor), rate(s.paymentCompletionBps), s.buyers, s.peakViewers ?? '', s.viewerData, rate(s.conversionBps)]));
    case 'products':
      return toCsv(['product_code', 'product', 'units_sold', 'orders', 'revenue'],
        r.topProducts.map((p) => [p.productCode, p.name, p.unitsSold, p.orders, koboToNaira(p.revenueMinor)]));
    case 'patterns':
      return toCsv(['weekday', 'hour', 'orders', 'paid_orders', 'gross_sales'],
        (r.patterns ?? []).map((p) => [WEEKDAYS[p.weekday - 1], `${String(p.hour).padStart(2, '0')}:00`, p.orders, p.paidOrders, koboToNaira(p.grossSalesMinor)]));
    case 'customers':
      return toCsv(['customer', 'paid_orders', 'spend', 'new_in_period'],
        (r.topCustomers ?? []).map((c) => [c.name, c.paidOrders, koboToNaira(c.spendMinor), c.newInRange ? 'yes' : 'no']));
  }
}

/** The PDF standard fonts are WinAnsi: keep Latin-1, replace anything else so the file never breaks. */
const latin = (s: string) => s.replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/** Printable report: summary with the previous period, channels, live sessions, top products. */
export function reportPdf(r: Report, store: { businessName: string; slug: string }, generatedAt = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Sales report ${r.range.from} to ${r.range.to}`, Author: 'LiveSell Africa', Subject: latin(store.businessName) } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const green = '#0e7a4d';
    const grey = '#5b6560';
    const ensure = (h: number) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
    const heading = (t: string) => { ensure(40); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#17201b').text(latin(t), left); doc.moveDown(0.3); };
    const table = (cols: Array<{ h: string; w: number; right?: boolean }>, rows: string[][]) => {
      const total = cols.reduce((s, c) => s + c.w, 0);
      const ws = cols.map((c) => (c.w / total) * width);
      const line = (cells: string[], bold: boolean) => {
        ensure(16);
        const y = doc.y;
        let x = left;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? grey : '#17201b');
        cells.forEach((c, i) => { doc.text(latin(c), x + 2, y, { width: ws[i] - 4, align: cols[i].right ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += ws[i]; });
        doc.y = y + 14;
        doc.moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.3).strokeColor('#e3e6e4').stroke();
      };
      line(cols.map((c) => c.h), true);
      if (!rows.length) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(grey).text('Nothing in this period.', left + 2); doc.moveDown(0.3); return; }
      rows.forEach((row) => line(row, false));
    };

    const o = r.overview;
    doc.font('Helvetica-Bold').fontSize(18).fillColor(green).text(latin(store.businessName), left);
    doc.font('Helvetica').fontSize(10).fillColor(grey)
      .text(`Sales report  |  ${r.range.from} to ${r.range.to} (${r.range.days} days, ${r.timezone})  |  ${latin(r.channel?.name ?? 'All channels')}`)
      .text(`Compared with ${r.previousRange.from} to ${r.previousRange.to}. Generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);

    heading('Summary');
    const cmp = (cur: string, prev: string) => [cur, prev];
    table([{ h: 'Metric', w: 3 }, { h: 'This period', w: 2, right: true }, { h: 'Previous period', w: 2, right: true }], [
      ['Orders', ...cmp(String(o.orders), String(r.comparison.orders.previous))],
      ['Paid orders', ...cmp(String(o.paidOrders), String(r.comparison.paidOrders.previous))],
      ['Gross sales', ...cmp(money(o.grossSalesMinor, r.currency), money(r.comparison.grossSalesMinor.previous as bigint, r.currency))],
      ['Refunds', money(o.refundsMinor, r.currency), ''],
      ['Net sales', ...cmp(money(o.netSalesMinor, r.currency), money(r.comparison.netSalesMinor.previous as bigint, r.currency))],
      ['Average order value', ...cmp(money(o.averageOrderValueMinor, r.currency), money(r.comparison.averageOrderValueMinor.previous as bigint, r.currency))],
      ['Units sold', ...cmp(String(o.unitsSold), String(r.comparison.unitsSold.previous))],
      ['Payment completion', ...cmp(pct(o.paymentCompletionBps), pct(r.comparison.paymentCompletionBps.previous))],
      ['Cancellation rate', ...cmp(pct(o.cancellationBps), pct(r.comparison.cancellationBps.previous))],
      ['Awaiting payment', String(o.awaitingPayment), ''],
      ['Live sessions / orders from live', `${o.liveSessions} / ${o.liveOrders}`, ''],
      ['Buyers / new customers', `${o.buyers} / ${o.newCustomers}`, String(r.comparison.newCustomers.previous)],
      ['Repeat buyers', `${o.repeatBuyers} (${pct(o.repeatPurchaseBps)})`, ''],
    ]);

    heading('Sales channels');
    table([{ h: 'Channel', w: 3 }, { h: 'Orders', w: 1, right: true }, { h: 'Paid', w: 1, right: true }, { h: 'Gross sales', w: 2, right: true }, { h: 'AOV', w: 2, right: true }, { h: 'Completion', w: 1.4, right: true }, { h: 'New cust.', w: 1.2, right: true }],
      r.channels.map((c) => [c.name, String(c.orders), String(c.paidOrders), money(c.grossSalesMinor, r.currency), money(c.averageOrderValueMinor, r.currency), pct(c.paymentCompletionBps), String(c.newCustomers)]));

    heading('Live sessions');
    table([{ h: 'Session', w: 3 }, { h: 'Started', w: 1.6 }, { h: 'Orders', w: 1, right: true }, { h: 'Paid', w: 1, right: true }, { h: 'Gross sales', w: 2, right: true }, { h: 'Units', w: 1, right: true }, { h: 'Conversion', w: 1.5, right: true }],
      r.sessions.map((s) => [`${s.title} (${s.channel})`, s.startedAt.toISOString().slice(0, 10), String(s.orders), String(s.paidOrders), money(s.grossSalesMinor, r.currency), String(s.unitsSold), s.conversionBps === null ? 'no viewer data' : `${pct(s.conversionBps)}*`]));
    if (r.sessions.some((s) => s.conversionBps !== null)) {
      doc.font('Helvetica').fontSize(7.5).fillColor(grey).text('* Buyers / peak viewers recorded by the seller. LiveSell never estimates viewer numbers.', left);
    }

    heading('Top products');
    table([{ h: 'Code', w: 1.3 }, { h: 'Product', w: 3.5 }, { h: 'Units', w: 1, right: true }, { h: 'Orders', w: 1, right: true }, { h: 'Revenue', w: 2, right: true }],
      r.topProducts.map((p) => [p.productCode, p.name, String(p.unitsSold), String(p.orders), money(p.revenueMinor, r.currency)]));

    doc.moveDown(1).font('Helvetica').fontSize(7.5).fillColor(grey)
      .text('Paid = payment verified by the payment provider or by the store (bank transfer). Orders are counted by the day they were placed, in the store currency. Net sales = gross sales minus completed refunds.', left, doc.y, { width });
    doc.end();
  });
}
