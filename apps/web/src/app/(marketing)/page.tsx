import { ButtonLink } from '@/components/ui';
import { HeroVisual } from '@/components/hero-visual';

const FEATURES: Array<{ title: string; body: string; soon?: boolean }> = [
  { title: 'Your branded storefront', body: 'livesell.africa/store/yourname with your logo, WhatsApp button and contact details.' },
  { title: 'Team roles', body: 'Invite store managers, sales assistants and live moderators — each sees only what their role allows.' },
  { title: 'Subscription or pay as you sell', body: 'Pick a fixed monthly plan, or no monthly fee and a small commission on each verified sale. Switch any time.' },
  { title: 'Sales dashboard', body: 'Sales today and this month, pending payments, top products and recent customers, from your real orders.' },
  { title: 'Product codes for live sessions', body: 'Every product gets a code like BAG001. Announce it in your live; customers look it up on your store and order.' },
  { title: 'Payments you can trust', body: 'Paystack, Flutterwave, Bachs or bank transfer. Orders are marked paid only after verification.', soon: true },
  { title: 'Order on WhatsApp', body: 'Customers fill a cart on your storefront and send you the order on WhatsApp, with codes and prices.' },
  { title: 'WhatsApp automation', body: 'Customers send a product code on WhatsApp and get an automatic reply with a checkout link.', soon: true },
];

const STEPS = [
  { n: '1', title: 'Set up your store', body: 'Register, upload your logo and invite your team. Takes a few minutes.' },
  { n: '2', title: 'Go live and share codes', body: 'Sell on TikTok, Instagram, Facebook or WhatsApp. Customers order with a product code or link.' },
  { n: '3', title: 'Get paid and deliver', body: 'Track payments, stock and dispatch from one dashboard — no more spreadsheets and screenshots.' },
];

export default function LandingPage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-2 lg:pb-24 lg:pt-20">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
              <span className="size-1.5 rounded-full bg-brand-500" /> Built for Nigerian social sellers
            </p>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl lg:text-[3.5rem]">
              Turn every live session into a sales opportunity.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-2">
              LiveSell Africa brings your orders, payments, stock and customers from TikTok, Instagram, Facebook and WhatsApp into one place.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/register" size="lg">Start your 14-day free trial</ButtonLink>
              <ButtonLink href="/pricing" size="lg" variant="secondary">See pricing</ButtonLink>
            </div>
            <p className="mt-3 text-sm text-ink-3">No card needed to start. Subscribe from ₦5,000/month, or pay only when you sell.</p>
          </div>
          <HeroVisual />
        </div>
      </section>

      <section id="how" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-[var(--radius-card)] border border-line p-5">
                <span className="grid size-8 place-items-center rounded-full bg-brand-600 text-sm font-semibold text-white">{s.n}</span>
                <h3 className="mt-4 font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Everything a social seller needs</h2>
        <p className="mt-2 max-w-2xl text-ink-2">We are rolling LiveSell out in stages. Features marked “Coming soon” are being built now and will switch on in your account automatically.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold">{f.title}</h3>
                {f.soon && <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink-3">Coming soon</span>}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-6 rounded-[var(--radius-card)] bg-brand-800 px-6 py-10 text-white sm:flex-row sm:items-center sm:px-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Ready for your next live?</h2>
            <p className="mt-1 text-brand-100">Set up your store today. Free for 14 days.</p>
          </div>
          <ButtonLink href="/register" size="lg" variant="secondary">Create your store</ButtonLink>
        </div>
      </section>
    </>
  );
}
