import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bps, Bucket, delta, parseRange, Range, RangeError400, Tier, TIER_LIMITS, tierOf } from './analytics-math';

const TZ = 'Africa/Lagos';
/** Orders that were paid at some point (refunded ones too: the sale happened, the refund is counted separately). */
const PAID = Prisma.sql`('PAID','PARTIALLY_REFUNDED','REFUNDED')`;
const AWAITING = Prisma.sql`('PENDING_PAYMENT','PAYMENT_VERIFICATION')`;

export interface AnalyticsQuery { from?: string; to?: string; channelId?: string }

interface Overview {
  orders: number; paidOrders: number; awaitingPayment: number; cancelledOrders: number;
  grossSalesMinor: bigint; refundsMinor: bigint; netSalesMinor: bigint; averageOrderValueMinor: bigint; unitsSold: number;
  paymentCompletionBps: number | null; cancellationBps: number | null;
  liveSessions: number; liveOrders: number;
  buyers: number; newCustomers: number; repeatBuyers: number; repeatPurchaseBps: number | null;
}

/**
 * Live selling and sales analytics (MASTER-SPEC §19), from real rows only.
 *
 * Definitions (also in docs/PHASE-10.md):
 * - Orders in a range = non-draft orders *created* in it, in the store's default currency (other currencies are not
 *   mixed in). Paid = payment status PAID, PARTIALLY_REFUNDED or REFUNDED — set only by verified payments.
 * - Gross sales = totals of those paid orders; refunds = completed refunds on them; net = gross − refunds.
 * - Payment completion = paid ÷ orders; cancellation = cancelled ÷ orders (basis points).
 * - New customers = customers whose first-ever order falls in the range (on that channel, when filtered).
 *   Repeat buyers = buyers in the range with at least two paid orders up to the range's end.
 * - Viewer numbers are never estimated: a session's conversion is shown only when the seller (or, later, a platform
 *   API) recorded peak viewers, and is labelled with that source.
 *
 * All SQL takes the tenant id as a bound parameter and filters every table by it.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Plan gate: analytics is a Professional-and-up feature (`features.analytics`); the dashboard stays on every plan. */
  async assertEnabled(tenantId: string): Promise<Tier> {
    const tier = await this.tier(tenantId);
    if (!tier) throw new ForbiddenException({ code: 'FEATURE_NOT_IN_PLAN', feature: 'analytics', message: 'Sales analytics and reports are on the Professional plan and above (and on Pay as you sell). Upgrade to see them.' });
    return tier;
  }

  /** The live plan's analytics tier, or null when the plan has none. */
  async tier(tenantId: string): Promise<Tier | null> {
    const sub = await this.prisma.forTenant(tenantId).subscription.findFirst({
      where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, include: { plan: { select: { features: true } } },
    });
    return sub ? tierOf((sub.plan.features as Record<string, unknown> | undefined)?.analytics) : null;
  }

  /** Throws when the tier doesn't include a capability (Business/Enterprise get the advanced ones). */
  assertTier(tier: Tier, feature: 'pdf' | 'schedules') {
    if (!TIER_LIMITS[tier][feature]) {
      throw new ForbiddenException({ code: 'FEATURE_NOT_IN_PLAN', feature: `analytics.${feature}`, message: feature === 'pdf' ? 'PDF reports are on the Business and Enterprise plans (and Pay as you sell).' : 'Scheduled email reports are on the Business and Enterprise plans (and Pay as you sell).' });
    }
  }

  async report(tenantId: string, q: AnalyticsQuery, tier: Tier = 'advanced') {
    const range = this.range(q);
    const limits = TIER_LIMITS[tier];
    if (range.days > limits.maxDays) {
      throw new ForbiddenException({ code: 'FEATURE_NOT_IN_PLAN', feature: 'analytics.long_range', maxDays: limits.maxDays, message: `Your plan covers up to ${limits.maxDays} days at a time. Business and Enterprise go up to a year.` });
    }
    const { currency, channel } = await this.context(tenantId, q.channelId);
    const [current, previous, series, channels, sessions, topProducts, patterns, topCustomers] = await Promise.all([
      this.overview(tenantId, currency, range.start, range.end, channel?.id),
      this.overview(tenantId, currency, range.previous.start, range.previous.end, channel?.id),
      this.series(tenantId, currency, range, channel?.id),
      this.channels(tenantId, currency, range),
      this.sessions(tenantId, currency, range, channel?.id),
      this.topProducts(tenantId, currency, range, channel?.id),
      limits.patterns ? this.patterns(tenantId, currency, range, channel?.id) : Promise.resolve(null),
      limits.topCustomers ? this.topCustomers(tenantId, currency, range, channel?.id) : Promise.resolve(null),
    ]);
    const cmp = <K extends keyof Overview>(k: K) => delta(current[k] as number | bigint, previous[k] as number | bigint);
    return {
      currency, timezone: TZ, range: { from: range.from, to: range.to, days: range.days, bucket: range.bucket },
      previousRange: { from: range.previous.from, to: range.previous.to },
      channel,
      overview: current,
      comparison: {
        orders: cmp('orders'), paidOrders: cmp('paidOrders'), grossSalesMinor: cmp('grossSalesMinor'), netSalesMinor: cmp('netSalesMinor'),
        averageOrderValueMinor: cmp('averageOrderValueMinor'), unitsSold: cmp('unitsSold'), newCustomers: cmp('newCustomers'),
        paymentCompletionBps: { previous: previous.paymentCompletionBps }, cancellationBps: { previous: previous.cancellationBps },
      },
      series, channels, sessions, topProducts,
      // Advanced tier only (null otherwise).
      patterns, topCustomers,
      tier, limits: { maxDays: limits.maxDays, pdf: limits.pdf, schedules: limits.schedules },
    };
  }

  // ───────────────────────── pieces ─────────────────────────

  private range(q: AnalyticsQuery): Range {
    try {
      return parseRange(q.from, q.to);
    } catch (e) {
      if (e instanceof RangeError400) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private async context(tenantId: string, channelId?: string) {
    const { defaultCurrency: currency } = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
    let channel: { id: string; name: string; type: string } | null = null;
    if (channelId) {
      channel = await this.prisma.forTenant(tenantId).salesChannel.findUnique({ where: { id: channelId }, select: { id: true, name: true, type: true } });
      if (!channel) throw new NotFoundException('Sales channel not found');
    }
    return { currency, channel };
  }

  private async overview(tenantId: string, currency: string, start: Date, end: Date, channelId?: string): Promise<Overview> {
    const inRange = this.inRange(tenantId, currency, start, end, channelId);
    const [[o], [u], [r], [c], [l]] = await Promise.all([
      this.prisma.$queryRaw<Array<{ orders: number; paid: number; awaiting: number; cancelled: number; gross: bigint; live: number }>>`
        SELECT COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS paid,
               COUNT(*) FILTER (WHERE o.status::text IN ${AWAITING})::int AS awaiting,
               COUNT(*) FILTER (WHERE o.status::text = 'CANCELLED')::int AS cancelled,
               COALESCE(SUM(o.total_minor) FILTER (WHERE o.payment_status::text IN ${PAID}), 0)::bigint AS gross,
               COUNT(*) FILTER (WHERE o.live_session_id IS NOT NULL)::int AS live
          FROM orders o WHERE ${inRange}`,
      this.prisma.$queryRaw<Array<{ units: number }>>`
        SELECT COALESCE(SUM(oi.quantity), 0)::int AS units
          FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ${tenantId}::uuid
         WHERE oi.tenant_id = ${tenantId}::uuid AND o.payment_status::text IN ${PAID} AND ${inRange}`,
      this.prisma.$queryRaw<Array<{ refunds: bigint }>>`
        SELECT COALESCE(SUM(r.amount_minor), 0)::bigint AS refunds
          FROM payment_refunds r
          JOIN payment_transactions t ON t.id = r.transaction_id AND t.tenant_id = ${tenantId}::uuid
          JOIN orders o ON o.id = t.order_id AND o.tenant_id = ${tenantId}::uuid
         WHERE r.tenant_id = ${tenantId}::uuid AND r.status::text = 'SUCCEEDED' AND r.currency = ${currency} AND ${inRange}`,
      this.prisma.$queryRaw<Array<{ buyers: number; repeat: number; fresh: number }>>`
        WITH buyers AS (
          SELECT DISTINCT o.customer_id FROM orders o WHERE ${inRange} AND o.customer_id IS NOT NULL AND o.payment_status::text IN ${PAID}
        ), firsts AS (
          SELECT DISTINCT ON (o.customer_id) o.customer_id, o.created_at, o.channel_id
            FROM orders o WHERE o.tenant_id = ${tenantId}::uuid AND o.status::text <> 'DRAFT' AND o.customer_id IS NOT NULL
           ORDER BY o.customer_id, o.created_at
        )
        SELECT (SELECT COUNT(*) FROM buyers)::int AS buyers,
               (SELECT COUNT(*) FROM (
                  SELECT o.customer_id FROM orders o
                   WHERE o.tenant_id = ${tenantId}::uuid AND o.customer_id IN (SELECT customer_id FROM buyers)
                     AND o.payment_status::text IN ${PAID} AND o.created_at < ${ts(end)}
                   GROUP BY o.customer_id HAVING COUNT(*) >= 2) x)::int AS repeat,
               (SELECT COUNT(*) FROM firsts f WHERE f.created_at >= ${ts(start)} AND f.created_at < ${ts(end)}
                  ${channelId ? Prisma.sql`AND f.channel_id = ${channelId}::uuid` : Prisma.empty})::int AS fresh`,
      this.prisma.$queryRaw<Array<{ sessions: number }>>`
        SELECT COUNT(*)::int AS sessions FROM live_sessions s
         WHERE s.tenant_id = ${tenantId}::uuid AND s.started_at IS NOT NULL AND s.started_at >= ${ts(start)} AND s.started_at < ${ts(end)}
           ${channelId ? Prisma.sql`AND s.channel_id = ${channelId}::uuid` : Prisma.empty}`,
    ]);
    const refunds = r.refunds;
    return {
      orders: o.orders, paidOrders: o.paid, awaitingPayment: o.awaiting, cancelledOrders: o.cancelled,
      grossSalesMinor: o.gross, refundsMinor: refunds, netSalesMinor: o.gross - refunds,
      averageOrderValueMinor: o.paid ? o.gross / BigInt(o.paid) : 0n, unitsSold: u.units,
      paymentCompletionBps: bps(o.paid, o.orders), cancellationBps: bps(o.cancelled, o.orders),
      liveSessions: l.sessions, liveOrders: o.live,
      buyers: c.buyers, newCustomers: c.fresh, repeatBuyers: c.repeat, repeatPurchaseBps: bps(c.repeat, c.buyers),
    };
  }

  /** Orders and gross sales per local day/week/month, zero-filled. */
  private async series(tenantId: string, currency: string, range: Range, channelId?: string) {
    const unit = range.bucket;
    const rows = await this.prisma.$queryRaw<Array<{ bucket: Date; orders: number; paid: number; gross: bigint }>>`
      WITH buckets AS (
        SELECT generate_series(date_trunc(${unit}, ${range.from}::date::timestamp), date_trunc(${unit}, ${range.to}::date::timestamp), ${`1 ${unit}`}::interval) AS bucket
      ), agg AS (
        SELECT date_trunc(${unit}, (o.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}) AS bucket,
               COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS paid,
               COALESCE(SUM(o.total_minor) FILTER (WHERE o.payment_status::text IN ${PAID}), 0)::bigint AS gross
          FROM orders o WHERE ${this.inRange(tenantId, currency, range.start, range.end, channelId)}
         GROUP BY 1
      )
      SELECT b.bucket, COALESCE(a.orders, 0)::int AS orders, COALESCE(a.paid, 0)::int AS paid, COALESCE(a.gross, 0)::bigint AS gross
        FROM buckets b LEFT JOIN agg a ON a.bucket = b.bucket ORDER BY b.bucket`;
    return rows.map((r) => ({ label: label(r.bucket, unit), orders: r.orders, paidOrders: r.paid, grossSalesMinor: r.gross }));
  }

  /** Every channel side by side (the channel filter doesn't apply: this is the comparison). */
  private async channels(tenantId: string, currency: string, range: Range) {
    const inRange = this.inRange(tenantId, currency, range.start, range.end);
    const rows = await this.prisma.$queryRaw<Array<{ id: string | null; name: string | null; type: string | null; orders: number; paid: number; cancelled: number; gross: bigint; fresh: number }>>`
      WITH agg AS (
        SELECT o.channel_id, COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS paid,
               COUNT(*) FILTER (WHERE o.status::text = 'CANCELLED')::int AS cancelled,
               COALESCE(SUM(o.total_minor) FILTER (WHERE o.payment_status::text IN ${PAID}), 0)::bigint AS gross
          FROM orders o WHERE ${inRange} GROUP BY o.channel_id
      ), firsts AS (
        SELECT DISTINCT ON (o.customer_id) o.customer_id, o.created_at, o.channel_id
          FROM orders o WHERE o.tenant_id = ${tenantId}::uuid AND o.status::text <> 'DRAFT' AND o.customer_id IS NOT NULL
         ORDER BY o.customer_id, o.created_at
      ), fresh AS (
        SELECT f.channel_id, COUNT(*)::int AS n FROM firsts f WHERE f.created_at >= ${ts(range.start)} AND f.created_at < ${ts(range.end)} GROUP BY f.channel_id
      )
      SELECT a.channel_id AS id, c.name, c.type::text AS type, a.orders, a.paid, a.cancelled, a.gross, COALESCE(fr.n, 0)::int AS fresh
        FROM agg a
        LEFT JOIN sales_channels c ON c.id = a.channel_id AND c.tenant_id = ${tenantId}::uuid
        LEFT JOIN fresh fr ON fr.channel_id IS NOT DISTINCT FROM a.channel_id
       ORDER BY a.gross DESC, a.orders DESC`;
    return rows.map((r) => ({
      channelId: r.id, name: r.name ?? 'No channel', type: r.type, orders: r.orders, paidOrders: r.paid, cancelledOrders: r.cancelled,
      grossSalesMinor: r.gross, averageOrderValueMinor: r.paid ? r.gross / BigInt(r.paid) : 0n,
      paymentCompletionBps: bps(r.paid, r.orders), cancellationBps: bps(r.cancelled, r.orders), newCustomers: r.fresh,
    }));
  }

  /** Live sessions started in the range, each with its own orders (whenever they were placed). */
  private async sessions(tenantId: string, currency: string, range: Range, channelId?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; title: string; channel: string; started: Date; ended: Date | null; peak: number | null; orders: number; paid: number; cancelled: number; gross: bigint; units: number; buyers: number }>>`
      SELECT s.id, s.title, c.name AS channel, s.started_at AS started, s.ended_at AS ended, s.peak_viewers AS peak,
             COUNT(o.id)::int AS orders,
             COUNT(o.id) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS paid,
             COUNT(o.id) FILTER (WHERE o.status::text = 'CANCELLED')::int AS cancelled,
             COALESCE(SUM(o.total_minor) FILTER (WHERE o.payment_status::text IN ${PAID}), 0)::bigint AS gross,
             COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders po ON po.id = oi.order_id AND po.tenant_id = ${tenantId}::uuid
                        WHERE oi.tenant_id = ${tenantId}::uuid AND po.live_session_id = s.id AND po.currency = ${currency} AND po.payment_status::text IN ${PAID}), 0)::int AS units,
             COUNT(DISTINCT o.customer_id) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS buyers
        FROM live_sessions s
        JOIN sales_channels c ON c.id = s.channel_id AND c.tenant_id = ${tenantId}::uuid
        LEFT JOIN orders o ON o.live_session_id = s.id AND o.tenant_id = ${tenantId}::uuid AND o.status::text <> 'DRAFT' AND o.currency = ${currency}
       WHERE s.tenant_id = ${tenantId}::uuid AND s.started_at IS NOT NULL AND s.started_at >= ${ts(range.start)} AND s.started_at < ${ts(range.end)}
         ${channelId ? Prisma.sql`AND s.channel_id = ${channelId}::uuid` : Prisma.empty}
       GROUP BY s.id, c.name
       ORDER BY s.started_at DESC
       LIMIT 200`;
    return rows.map((r) => ({
      id: r.id, title: r.title, channel: r.channel, startedAt: utc(r.started), endedAt: r.ended ? utc(r.ended) : null,
      durationMinutes: r.ended ? Math.round((utc(r.ended).getTime() - utc(r.started).getTime()) / 60_000) : null,
      orders: r.orders, paidOrders: r.paid, cancelledOrders: r.cancelled, grossSalesMinor: r.gross, unitsSold: r.units,
      averageOrderValueMinor: r.paid ? r.gross / BigInt(r.paid) : 0n, paymentCompletionBps: bps(r.paid, r.orders),
      buyers: r.buyers, peakViewers: r.peak,
      // Only with recorded viewers; never estimated (§19).
      conversionBps: r.peak && r.peak > 0 ? bps(r.buyers, r.peak) : null,
      viewerData: r.peak === null ? 'not_provided' as const : 'seller_reported' as const,
    }));
  }

  private async topProducts(tenantId: string, currency: string, range: Range, channelId?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; code: string; units: number; revenue: bigint; orders: number }>>`
      SELECT p.id, p.name, p.product_code AS code, SUM(oi.quantity)::int AS units, SUM(oi.line_total_minor)::bigint AS revenue, COUNT(DISTINCT o.id)::int AS orders
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ${tenantId}::uuid
        JOIN product_variants v ON v.id = oi.variant_id AND v.tenant_id = ${tenantId}::uuid
        JOIN products p ON p.id = v.product_id AND p.tenant_id = ${tenantId}::uuid
       WHERE oi.tenant_id = ${tenantId}::uuid AND o.payment_status::text IN ${PAID} AND ${this.inRange(tenantId, currency, range.start, range.end, channelId)}
       GROUP BY p.id, p.name, p.product_code
       ORDER BY units DESC, revenue DESC
       LIMIT 10`;
    return rows.map((r) => ({ productId: r.id, name: r.name, productCode: r.code, unitsSold: r.units, revenueMinor: r.revenue, orders: r.orders }));
  }

  /** When orders come in: weekday (1 = Monday) × hour (Lagos). Only non-empty cells. */
  private async patterns(tenantId: string, currency: string, range: Range, channelId?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ dow: number; hour: number; orders: number; paid: number; gross: bigint }>>`
      SELECT EXTRACT(ISODOW FROM (o.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS dow,
             EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS hour,
             COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE o.payment_status::text IN ${PAID})::int AS paid,
             COALESCE(SUM(o.total_minor) FILTER (WHERE o.payment_status::text IN ${PAID}), 0)::bigint AS gross
        FROM orders o WHERE ${this.inRange(tenantId, currency, range.start, range.end, channelId)}
       GROUP BY 1, 2 ORDER BY 1, 2`;
    return rows.map((r) => ({ weekday: r.dow, hour: r.hour, orders: r.orders, paidOrders: r.paid, grossSalesMinor: r.gross }));
  }

  /** Best customers by paid spend in the range (name only; phone and email stay in Customers). */
  private async topCustomers(tenantId: string, currency: string, range: Range, channelId?: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; orders: number; spend: bigint; first: Date }>>`
      SELECT c.id, c.full_name AS name, COUNT(o.id)::int AS orders, SUM(o.total_minor)::bigint AS spend,
             (SELECT MIN(f.created_at) FROM orders f WHERE f.tenant_id = ${tenantId}::uuid AND f.customer_id = c.id AND f.status::text <> 'DRAFT') AS first
        FROM orders o JOIN customers c ON c.id = o.customer_id AND c.tenant_id = ${tenantId}::uuid AND c.anonymized_at IS NULL
       WHERE o.payment_status::text IN ${PAID} AND ${this.inRange(tenantId, currency, range.start, range.end, channelId)}
       GROUP BY c.id, c.full_name
       ORDER BY spend DESC, orders DESC
       LIMIT 10`;
    return rows.map((r) => ({ customerId: r.id, name: r.name, paidOrders: r.orders, spendMinor: r.spend, newInRange: r.first >= range.start }));
  }

  private inRange(tenantId: string, currency: string, start: Date, end: Date, channelId?: string) {
    return Prisma.sql`o.tenant_id = ${tenantId}::uuid AND o.status::text <> 'DRAFT' AND o.currency = ${currency}
      AND o.created_at >= ${ts(start)} AND o.created_at < ${ts(end)}
      ${channelId ? Prisma.sql`AND o.channel_id = ${channelId}::uuid` : Prisma.empty}`;
  }
}

/** Timestamp columns hold UTC wall time without a zone. */
const ts = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
/** The driver reads zoneless UTC timestamps as UTC already. */
const utc = (d: Date) => d;

function label(bucket: Date, unit: Bucket) {
  const iso = bucket.toISOString();
  return unit === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}
