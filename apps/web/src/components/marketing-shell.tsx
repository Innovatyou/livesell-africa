'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ButtonLink, Logo } from './ui';

export function MarketingHeader() {
  const { status } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="LiveSell Africa home"><Logo /></Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          <Link href="/#features" className="rounded-md px-3 py-2 text-sm text-ink-2 hover:text-ink">Features</Link>
          <Link href="/#how" className="rounded-md px-3 py-2 text-sm text-ink-2 hover:text-ink">How it works</Link>
          <Link href="/pricing" className="rounded-md px-3 py-2 text-sm text-ink-2 hover:text-ink">Pricing</Link>
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {status === 'authenticated' ? (
            <ButtonLink href="/dashboard" size="sm">Go to dashboard</ButtonLink>
          ) : (
            <>
              <ButtonLink href="/login" variant="ghost" size="sm">Sign in</ButtonLink>
              <ButtonLink href="/register" size="sm">Start free trial</ButtonLink>
            </>
          )}
        </div>
        <button className="grid size-10 place-items-center rounded-md text-ink-2 md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>
      {open && (
        <nav className="border-t border-line bg-surface px-4 py-3 md:hidden" aria-label="Mobile">
          <div className="flex flex-col gap-1">
            {[['/#features', 'Features'], ['/#how', 'How it works'], ['/pricing', 'Pricing']].map(([href, label]) => (
              <Link key={href} href={href} onClick={() => setOpen(false)} className="rounded-md px-2 py-2.5 text-sm text-ink-2">{label}</Link>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              {status === 'authenticated' ? (
                <ButtonLink href="/dashboard" className="col-span-2">Go to dashboard</ButtonLink>
              ) : (
                <>
                  <ButtonLink href="/login" variant="secondary">Sign in</ButtonLink>
                  <ButtonLink href="/register">Start free trial</ButtonLink>
                </>
              )}
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <Logo />
          <p className="mt-2 text-sm text-ink-3">Built for Nigeria first. Designed for Africa.</p>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-2" aria-label="Footer">
          <Link href="/pricing" className="hover:text-ink">Pricing</Link>
          <Link href="/contact" className="hover:text-ink">Contact sales</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/login" className="hover:text-ink">Sign in</Link>
        </nav>
      </div>
    </footer>
  );
}
