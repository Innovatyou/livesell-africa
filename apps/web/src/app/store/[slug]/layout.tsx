import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CartButton, CartProvider } from '@/components/store/cart';
import { fetchStore } from '@/lib/storefront';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const store = await fetchStore(slug).catch(() => null);
  if (!store) return { title: 'Store not found' };
  return {
    title: { default: store.businessName, template: `%s · ${store.businessName}` },
    description: store.description ?? `Shop ${store.businessName} on LiveSell Africa.`,
    openGraph: { title: store.businessName, description: store.description ?? undefined, images: store.coverUrl ? [store.coverUrl] : store.logoUrl ? [store.logoUrl] : undefined },
  };
}

const SOCIAL: Record<string, (h: string) => string> = {
  instagram: (h) => `https://instagram.com/${h.replace(/^@/, '')}`, tiktok: (h) => `https://www.tiktok.com/@${h.replace(/^@/, '')}`,
  facebook: (h) => `https://facebook.com/${h.replace(/^@/, '')}`, x: (h) => `https://x.com/${h.replace(/^@/, '')}`,
  youtube: (h) => `https://youtube.com/@${h.replace(/^@/, '')}`,
};

export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Params }) {
  const { slug } = await params;
  const store = await fetchStore(slug);
  if (!store) notFound();
  const accent = store.accentColor ?? '#0e7a4d';
  return (
    <CartProvider slug={store.slug}>
      <div style={{ ['--accent' as string]: accent }} className="min-h-dvh bg-canvas">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4">
            <Link href={`/store/${store.slug}`} className="flex min-w-0 items-center gap-3">
              {store.logoUrl
                ? <img src={store.logoUrl} alt="" className="size-9 shrink-0 rounded-lg object-cover" />
                : <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-sm font-semibold text-white">{store.businessName.slice(0, 1)}</span>}
              <span className="truncate font-semibold">{store.businessName}</span>
              {store.verified && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">Verified</span>}
            </Link>
            <CartButton slug={store.slug} />
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 pb-24 pt-4">{children}</main>
        <footer className="border-t border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-sm text-ink-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(store.socialLinks ?? {}).filter(([k, v]) => v && (SOCIAL[k] || k === 'website')).map(([k, v]) => (
                <a key={k} href={k === 'website' ? v : SOCIAL[k](v)} target="_blank" rel="noopener noreferrer nofollow" className="capitalize hover:text-ink">{k === 'x' ? 'X' : k}</a>
              ))}
              {store.contactEmail && <a href={`mailto:${store.contactEmail}`} className="hover:text-ink">Email</a>}
            </div>
            <Link href="/" className="text-ink-3 hover:text-ink">Powered by LiveSell Africa</Link>
          </div>
        </footer>
        {store.whatsappNumber && (
          <a href={`https://wa.me/${store.whatsappNumber.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer"
            className="fixed bottom-4 right-4 z-30 inline-flex h-12 items-center gap-2 rounded-full bg-[#1f8b4c] px-5 text-sm font-semibold text-white shadow-[var(--shadow-pop)]" aria-label="Chat on WhatsApp">
            <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z" /></svg>
            WhatsApp
          </a>
        )}
      </div>
    </CartProvider>
  );
}
