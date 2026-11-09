'use client';

import { useEffect, useRef, useState } from 'react';
import { formatCount, formatMoney, formatMoneyCompact, toMinor } from '@/lib/money';
import type { ChartPeriod, SalesChart as Chart } from '@/lib/types';

const H = 232;
const PAD = { top: 12, right: 8, bottom: 28, left: 56 };
const BAR_MAX = 24;
const GAP = 2;

/** Bucket labels arrive as WAT calendar strings: "2026-11-05", "2026-11", "2026". */
export function formatBucket(label: string, period: ChartPeriod, long = false): string {
  const [y, m = '01', d = '01'] = label.split('-');
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-NG', { timeZone: 'UTC', ...o }).format(date);
  if (period === 'yearly') return y;
  if (period === 'monthly') return fmt(long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  if (period === 'weekly') return long ? `Week of ${fmt({ day: 'numeric', month: 'short', year: 'numeric' })}` : fmt({ day: 'numeric', month: 'short' });
  return fmt(long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
}

/** Round the axis maximum up to 1, 2, 2.5 or 5 × 10ⁿ naira so ticks land on clean numbers. */
function niceMax(v: number) {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** Column path: 4px rounded data-end, square at the baseline. */
function column(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function SalesChart({ data }: { data: Chart }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = data.points;
  // Geometry only: naira as a JS number is exact far beyond any realistic chart value.
  const values = pts.map((p) => Number(toMinor(p.amountMinor) / 100n));
  const max = niceMax(Math.max(...values, 0));
  const empty = values.every((v) => v === 0);
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / pts.length;
  const barW = Math.max(2, Math.min(BAR_MAX, band - GAP));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(plotW / 64))));
  const h = hover !== null ? pts[hover] : null;

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button className="text-[13px] font-medium text-ink-3 hover:text-ink" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-sunken text-left text-[13px] text-ink-3">
              <tr><th className="px-3 py-2 font-medium">Period</th><th className="px-3 py-2 text-right font-medium">Sales</th><th className="px-3 py-2 text-right font-medium">Payments</th></tr>
            </thead>
            <tbody>
              {[...pts].reverse().map((p) => (
                <tr key={p.label} className="border-t border-line">
                  <td className="px-3 py-2 text-ink-2">{formatBucket(p.label, data.period, true)}</td>
                  <td className="px-3 py-2 text-right tabular">{formatMoney(p.amountMinor, data.currency)}</td>
                  <td className="px-3 py-2 text-right tabular text-ink-2">{formatCount(p.payments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className="relative overflow-hidden" onMouseLeave={() => setHover(null)}>
          <svg width={width} height={H} role="img" aria-label={`Verified sales by ${data.period.replace('ly', '')}, total ${formatMoney(data.totalMinor, data.currency)}`} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[11px] tabular">
                  {formatMoneyCompact(BigInt(Math.round(t)) * 100n, data.currency)}
                </text>
              </g>
            ))}
            {pts.map((p, i) => {
              const v = values[i];
              const cx = PAD.left + band * i + band / 2;
              const top = y(v);
              const hgt = PAD.top + plotH - top;
              return (
                <g key={p.label}>
                  {v > 0 && <path d={column(cx - barW / 2, top, barW, hgt)} fill={hover === null || hover === i ? 'var(--color-brand-600)' : 'var(--color-brand-200)'} />}
                  {i % labelEvery === (pts.length - 1) % labelEvery && (
                    <text x={cx} y={H - 8} textAnchor="middle" className="fill-ink-3 text-[11px]">{formatBucket(p.label, data.period)}</text>
                  )}
                  {/* Hit target: the whole band, taller than the mark. */}
                  <rect
                    x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent"
                    tabIndex={0} aria-label={`${formatBucket(p.label, data.period, true)}: ${formatMoney(p.amountMinor, data.currency)}`}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {h && hover !== null && (
            <div
              className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-[var(--shadow-pop)]"
              style={{ left: Math.min(Math.max(PAD.left + band * hover + band / 2 - 72, 0), width - 150), top: 0 }}
            >
              <p className="text-[12px] text-ink-3">{formatBucket(h.label, data.period, true)}</p>
              <p className="font-semibold tabular text-ink">{formatMoney(h.amountMinor, data.currency)}</p>
              <p className="text-[12px] text-ink-3 tabular">{formatCount(h.payments)} verified payment{h.payments === 1 ? '' : 's'}</p>
            </div>
          )}
          {empty && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center" style={{ paddingLeft: PAD.left, paddingBottom: PAD.bottom }}>
              <p className="rounded-full bg-surface/90 px-3 py-1 text-sm text-ink-3">No verified sales in this period yet</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
