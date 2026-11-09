import { bps, delta, money, parseRange } from '../analytics/analytics-math';
import { reportCsv } from '../analytics/analytics-export';
import { canMoveDelivery, deliverySettings, deliveryStatusFor, dispatchNote, matchZone, orderStatusFor, quoteDelivery, ZoneLike } from './delivery-rules';

const zone = (over: Partial<ZoneLike>): ZoneLike => ({ id: 'z', name: 'Z', states: [], cities: [], feeMinor: 100000n, etaDays: 2, isActive: true, ...over });
const lagos = zone({ id: 'lagos', name: 'Lagos', states: ['Lagos'], feeMinor: 300000n });
const ikeja = zone({ id: 'ikeja', name: 'Ikeja', states: ['Lagos'], cities: ['Ikeja', 'Ogba'], feeMinor: 150000n });
const abuja = zone({ id: 'abuja', name: 'Abuja', states: ['FCT', 'Abuja'], feeMinor: 500000n, isActive: false });

describe('delivery zones', () => {
  it('a zone naming the city beats a state-wide one; matching ignores case, spaces and "State"', () => {
    expect(matchZone([lagos, ikeja], { state: 'lagos state', city: ' IKEJA ' })?.id).toBe('ikeja');
    expect(matchZone([lagos, ikeja], { state: 'Lagos', city: 'Surulere' })?.id).toBe('lagos');
    expect(matchZone([lagos, ikeja], { state: 'Ogun', city: 'Ikeja' })).toBeNull(); // city list is inside its states
  });
  it('inactive and empty zones never match; among equals the cheaper wins', () => {
    expect(matchZone([abuja], { state: 'FCT', city: 'Garki' })).toBeNull();
    expect(matchZone([zone({})], { state: 'Lagos', city: 'Yaba' })).toBeNull();
    const cheap = zone({ id: 'cheap', states: ['Lagos'], feeMinor: 1000n });
    expect(matchZone([lagos, cheap], { state: 'Lagos', city: 'Yaba' })?.id).toBe('cheap');
  });
  it('quotes: zone fee, to-be-agreed without zones, refused outside zones when the store says so', () => {
    const s = deliverySettings({});
    expect(quoteDelivery([lagos], s, { state: 'Lagos', city: 'Yaba' })).toMatchObject({ available: true, feeMinor: 300000n, feeToBeAgreed: false, zone: { id: 'lagos' } });
    expect(quoteDelivery([], s, { state: 'Kano', city: 'Kano' })).toMatchObject({ available: true, feeMinor: 0n, feeToBeAgreed: true, zone: null });
    expect(quoteDelivery([lagos], s, { state: 'Kano', city: 'Kano' })).toMatchObject({ available: true, feeToBeAgreed: true });
    expect(quoteDelivery([lagos], deliverySettings({ deliverOutsideZones: false }), { state: 'Kano', city: 'Kano' })).toMatchObject({ available: false, feeMinor: null });
  });
  it('pickup needs an address', () => {
    expect(deliverySettings({ pickupEnabled: true }).pickupEnabled).toBe(false);
    expect(deliverySettings({ pickupEnabled: true, pickupAddress: ' Shop 4, Ikeja ' })).toMatchObject({ pickupEnabled: true, pickupAddress: 'Shop 4, Ikeja', deliverOutsideZones: true });
  });
});

describe('delivery status', () => {
  it('moves forward, can retry after a failed attempt, and stops at delivered/returned', () => {
    expect(canMoveDelivery('PENDING', 'IN_TRANSIT', 'SELLER_DELIVERY')).toBe(true);
    expect(canMoveDelivery('IN_TRANSIT', 'FAILED', 'THIRD_PARTY')).toBe(true);
    expect(canMoveDelivery('FAILED', 'IN_TRANSIT', 'THIRD_PARTY')).toBe(true);
    expect(canMoveDelivery('DELIVERED', 'IN_TRANSIT', 'SELLER_DELIVERY')).toBe(false);
    expect(canMoveDelivery('RETURNED', 'DELIVERED', 'SELLER_DELIVERY')).toBe(false);
    expect(canMoveDelivery('PENDING', 'RETURNED', 'SELLER_DELIVERY')).toBe(false);
  });
  it('pickup is collected or not: no rider, no transit, no return', () => {
    expect(canMoveDelivery('PENDING', 'DELIVERED', 'PICKUP')).toBe(true);
    expect(canMoveDelivery('PENDING', 'IN_TRANSIT', 'PICKUP')).toBe(false);
    expect(canMoveDelivery('PENDING', 'ASSIGNED', 'PICKUP')).toBe(false);
  });
  it('drives the order and follows it', () => {
    expect(orderStatusFor('IN_TRANSIT', 'SELLER_DELIVERY')).toBe('DISPATCHED');
    expect(orderStatusFor('DELIVERED', 'PICKUP')).toBe('DELIVERED');
    expect(orderStatusFor('FAILED', 'THIRD_PARTY')).toBeNull();
    expect(deliveryStatusFor('DISPATCHED', 'SELLER_DELIVERY')).toBe('IN_TRANSIT');
    expect(deliveryStatusFor('DISPATCHED', 'PICKUP')).toBeNull();
    expect(deliveryStatusFor('PROCESSING', 'SELLER_DELIVERY')).toBeNull();
  });
  it('dispatch note for the customer', () => {
    expect(dispatchNote({ method: 'THIRD_PARTY', carrierName: 'GIG Logistics', trackingReference: 'GIG-1', dispatchNote: null })).toBe('Sent with GIG Logistics, tracking GIG-1');
    expect(dispatchNote({ method: 'SELLER_DELIVERY', carrierName: null, trackingReference: null, dispatchNote: null })).toBeNull();
  });
});

describe('analytics helpers', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  it('ranges are whole Lagos days, default 30 days, with the previous period of the same length', () => {
    const r = parseRange(undefined, undefined, now);
    expect(r).toMatchObject({ from: '2026-10-08', to: '2026-11-06', days: 30, bucket: 'day' });
    expect(r.start.toISOString()).toBe('2026-10-07T23:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-06T23:00:00.000Z');
    expect(r.previous).toMatchObject({ from: '2026-09-08', to: '2026-10-07' });
    expect(parseRange('2026-01-01', '2026-06-30', now).bucket).toBe('week');
    expect(parseRange('2025-11-06', '2026-11-06', now)).toMatchObject({ days: 366, bucket: 'month' });
  });
  it('a late-evening UTC time is already the next Lagos day', () => {
    expect(parseRange(undefined, undefined, new Date('2026-11-06T23:30:00Z')).to).toBe('2026-11-07');
  });
  it('rejects bad, reversed, future and too-long ranges', () => {
    expect(() => parseRange('2026-02-30', '2026-03-01', now)).toThrow('Invalid date');
    expect(() => parseRange('2026-11-05', '2026-11-01', now)).toThrow('after');
    expect(() => parseRange('2026-11-01', '2026-11-08', now)).toThrow('future');
    expect(() => parseRange('2025-01-01', '2026-11-01', now)).toThrow('at most');
  });
  it('rates in basis points and changes, without floats', () => {
    expect(bps(1, 3)).toBe(3333);
    expect(bps(2, 3)).toBe(6667);
    expect(bps(5, 0)).toBeNull();
    expect(delta(150n, 100n)).toEqual({ previous: 100n, change: 50n, changeBps: 5000 });
    expect(delta(5, 0)).toEqual({ previous: 0, change: 5, changeBps: null });
    expect(delta(1, 3)).toEqual({ previous: 3, change: -2, changeBps: -6667 });
    expect(money(250000050n)).toBe('NGN 2,500,000.50');
  });
  it('CSV report: summary rows with the previous period, amounts in naira', () => {
    const report = {
      currency: 'NGN', range: { from: '2026-10-01', to: '2026-10-31', days: 31, bucket: 'day' }, previousRange: { from: '2026-08-31', to: '2026-09-30' }, channel: null,
      overview: { orders: 3, paidOrders: 2, awaitingPayment: 1, cancelledOrders: 0, grossSalesMinor: 5000000n, refundsMinor: 0n, netSalesMinor: 5000000n, averageOrderValueMinor: 2500000n, unitsSold: 2, paymentCompletionBps: 6667, cancellationBps: 0, liveSessions: 1, liveOrders: 2, buyers: 2, newCustomers: 2, repeatBuyers: 0, repeatPurchaseBps: 0 },
      comparison: { orders: { previous: 1 }, paidOrders: { previous: 1 }, grossSalesMinor: { previous: 2500000n }, netSalesMinor: { previous: 2500000n }, averageOrderValueMinor: { previous: 2500000n }, unitsSold: { previous: 1 }, newCustomers: { previous: 1 }, paymentCompletionBps: { previous: 10000 }, cancellationBps: { previous: 0 } },
      series: [], channels: [], sessions: [], topProducts: [],
    } as never;
    const csv = reportCsv(report, 'summary');
    expect(csv).toContain('gross_sales,50000.00,25000.00');
    expect(csv).toContain('payment_completion_pct,66.67,100.00');
    expect(reportCsv(report, 'sessions').trim().split('\r\n')).toHaveLength(1); // header only
  });
});

describe('Phase 10b', () => {
  it('commission invoices: only amounts at or above the minimum, carried over otherwise', async () => {
    const { commissionToInvoice } = await import('../billing/commission-billing.service');
    expect(commissionToInvoice(225_000n, 0n, 100_000n)).toBe(225_000n);
    expect(commissionToInvoice(75_000n, 0n, 100_000n)).toBe(0n);
    expect(commissionToInvoice(300_000n, 225_000n, 100_000n)).toBe(0n); // only ₦750 new
    expect(commissionToInvoice(100_000n, 150_000n, 0n)).toBe(0n); // refunds after billing: credit, no invoice
  });

  it('Lagos months', async () => {
    const { lagosMonthStart, previousMonthStart, monthLabel } = await import('../billing/commission-billing.service');
    expect(lagosMonthStart(new Date('2026-11-06T10:00:00Z')).toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(lagosMonthStart(new Date('2026-10-31T23:30:00Z')).toISOString()).toBe('2026-10-31T23:00:00.000Z'); // already 1 Nov in Lagos
    expect(previousMonthStart(new Date('2026-01-01T00:00:00+01:00')).toISOString()).toBe('2025-11-30T23:00:00.000Z');
    expect(monthLabel(new Date('2026-09-30T23:00:00Z'))).toBe('October 2026');
  });

  it('paying a commission invoice balances on both sides', async () => {
    const { commissionSettlementJournals, toEntries } = await import('../ledger/ledger.service');
    const j = commissionSettlementJournals(195_000n, 2_925n);
    expect(() => toEntries(j.seller)).not.toThrow();
    expect(() => toEntries(j.platform)).not.toThrow();
    expect(j.platform.find((l) => l.account === 'COMMISSION_RECEIVABLE')!.amountMinor).toBe(-195_000n);
  });

  it('analytics tiers and report periods', async () => {
    const { lastCompleteMonth, lastCompleteWeek, tierOf, TIER_LIMITS } = await import('../analytics/analytics-math');
    expect(tierOf(false)).toBeNull();
    expect(tierOf('standard')).toBe('standard');
    expect(tierOf('advanced')).toBe('advanced');
    expect(TIER_LIMITS.standard).toMatchObject({ maxDays: 92, pdf: false });
    expect(lastCompleteWeek(new Date('2026-11-06T10:00:00Z'))).toMatchObject({ from: '2026-10-26', to: '2026-11-01', label: '2026-W44' }); // Friday → previous Mon–Sun
    expect(lastCompleteWeek(new Date('2026-11-09T08:00:00Z'))).toMatchObject({ from: '2026-11-02', to: '2026-11-08', label: '2026-W45' });
    expect(lastCompleteWeek(new Date('2027-01-04T08:00:00Z'))).toMatchObject({ from: '2026-12-28', label: '2026-W53' });
    expect(lastCompleteMonth(new Date('2026-01-02T08:00:00Z'))).toMatchObject({ from: '2025-12-01', to: '2025-12-31', label: '2025-12', periodLabel: 'December 2025' });
  });

  it('report email: escaped, with the change against the previous period', async () => {
    const { analyticsReportEmail, vsPrevious } = await import('../notifications/analytics-report');
    expect(vsPrevious('150', '100')).toBe('+50.0% vs the period before');
    expect(vsPrevious(5, 0)).toBe('up from nothing the period before');
    expect(vsPrevious(3, 3)).toBe('same as the period before');
    const m = analyticsReportEmail({
      storeName: 'Ada <b>', frequency: 'WEEKLY', periodLabel: 'Week of 2 Nov 2026', from: '2026-11-02', to: '2026-11-08', currency: 'NGN',
      grossSalesMinor: '5000000', previousGrossSalesMinor: '2500000', netSalesMinor: '5000000', refundsMinor: '0', orders: 3, previousOrders: 1, paidOrders: 2,
      averageOrderValueMinor: '2500000', paymentCompletionBps: 6667, newCustomers: 2, liveSessions: 1, topProduct: null, bestChannel: null,
    }, 'https://app.test');
    expect(m.subject).toBe('Ada <b>: Weekly report — Week of 2 Nov 2026');
    expect(m.html).toContain('Ada &lt;b&gt;');
    expect(m.html).toContain('₦50,000');
    expect(m.html).toContain('+100.0% vs the period before');
    expect(m.html).toContain('https://app.test/analytics?from=2026-11-02&amp;to=2026-11-08');
  });

  it('dispatch note carries the courier phone only when given', () => {
    expect(dispatchNote({ method: 'SELLER_DELIVERY', carrierName: 'Musa', carrierPhone: '+2348030000001', trackingReference: null, dispatchNote: null })).toBe('Sent with Musa (+2348030000001)');
  });
});
