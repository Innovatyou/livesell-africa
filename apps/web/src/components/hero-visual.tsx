'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * Landing-page hero visual. The 3D scene (three.js + react-three-fiber, ~200 KB gzipped) is only downloaded on
 * wide screens, when the user hasn't asked for reduced motion or data saving, and after the page is idle.
 * Everyone else — including most phones on mobile data — gets the static illustration, which is also what
 * renders on the server and during loading.
 */
const HeroScene = dynamic(() => import('./hero-scene'), { ssr: false, loading: () => null });

function shouldLoad3D() {
  if (typeof window === 'undefined') return false;
  const wide = window.matchMedia('(min-width: 1024px)').matches;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  let webgl = false;
  try {
    webgl = !!document.createElement('canvas').getContext('webgl2');
  } catch {
    webgl = false;
  }
  return wide && !calm && !saveData && webgl;
}

export function HeroVisual() {
  const [use3D, setUse3D] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!shouldLoad3D()) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const start = () => setUse3D(true);
    if (idle) idle(start, { timeout: 2500 });
    else setTimeout(start, 1200);
  }, []);

  return (
    <div className="relative mx-auto aspect-[4/5] w-full max-w-md lg:max-w-none">
      <div className={`absolute inset-0 transition-opacity duration-700 ${ready ? 'opacity-0' : 'opacity-100'}`}>
        <StaticIllustration />
      </div>
      {use3D && (
        <div className={`absolute inset-0 transition-opacity duration-700 ${ready ? 'opacity-100' : 'opacity-0'}`}>
          <HeroScene onReady={() => setReady(true)} />
          <FloatingOrderCards />
        </div>
      )}
    </div>
  );
}

/** Example cards (illustrative copy from the product brief, not live data). */
function FloatingOrderCards() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute left-2 top-[18%] rounded-xl border border-line bg-surface/95 px-3.5 py-2.5 shadow-[var(--shadow-pop)]">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Comment</p>
        <p className="text-sm font-semibold text-ink">“BAG001 please 🙏🏾”</p>
      </div>
      <div className="absolute bottom-[16%] right-2 rounded-xl border border-line bg-surface/95 px-3.5 py-2.5 shadow-[var(--shadow-pop)]">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Order paid</p>
        <p className="text-sm font-semibold text-ink">Premium Leather Bag · ₦25,000</p>
      </div>
    </div>
  );
}

function StaticIllustration() {
  return (
    <div aria-hidden className="relative h-full w-full">
      <div className="absolute inset-[8%] rounded-[36px] bg-gradient-to-br from-brand-100 via-brand-50 to-surface" />
      <div className="absolute left-1/2 top-1/2 w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-line bg-surface p-3 shadow-[var(--shadow-pop)]">
        <div className="flex items-center justify-between px-1 pb-3 pt-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bad px-2 py-0.5 text-[11px] font-semibold text-white">
            <span className="size-1.5 rounded-full bg-white" /> LIVE
          </span>
          <span className="text-[11px] text-ink-3">@fashionbyada</span>
        </div>
        <div className="aspect-[3/4] rounded-2xl bg-gradient-to-b from-brand-600 to-brand-900" />
        <div className="mt-3 space-y-2">
          {[['BAG001', 'Premium Leather Bag', '₦25,000'], ['SHOE002', "Men's Sneakers", '₦18,500']].map(([code, name, price]) => (
            <div key={code} className="flex items-center justify-between rounded-xl border border-line px-3 py-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-brand-700">{code}</p>
                <p className="truncate text-xs text-ink-2">{name}</p>
              </div>
              <p className="text-xs font-semibold text-ink tabular">{price}</p>
            </div>
          ))}
        </div>
      </div>
      <FloatingOrderCards />
    </div>
  );
}
