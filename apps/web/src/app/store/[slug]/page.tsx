import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CodeLookup } from '@/components/store/code-lookup';
import { formatMoney } from '@/lib/money';
import { fetchProducts, fetchStore } from '@/lib/storefront';
import type { Availability } from '@/lib/types';

type Params = Promise<{ slug: string }>;
type Search = Promise<{ q?: string; category?: string; sort?: string; page?: string }>;

const AVAIL: Record<Availability, string> = { in_stock: '', low_stock: 'Few left', out_of_stock: 'Sold out', preorder: 'Pre-order' };

export default async function StorePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { slug } = await params;
  const sp = await searchParams;
  const store = await fetchStore(slug);
  if (!store) notFound();
  const page = Math.max(1, Number(sp.page) || 1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '24' });
  if (sp.q) qs.set('search', sp.q.slice(0, 80));
  if (sp.category && /^[a-z0-9-]{1,80}$/.test(sp.category)) qs.set('category', sp.category);
  if (sp.sort === 'price_asc' || sp.sort === 'price_desc') qs.set('sort', sp.sort);
  const products = await fetchProducts(slug, qs.toString());
  if (!products) notFound();
  const pages = Math.max(1, Math.ceil(products.total / products.pageSize));
  const link = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q: sp.q, category: sp.category, sort: sp.sort, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/store/${store.slug}${s ? `?${s}` : ''}`;
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        {store.coverUrl && <img src={store.coverUrl} alt="" className="aspect-[3/1] w-full object-cover" />}
        <div className="space-y-2 p-5">
          <h1 className="text-2xl font-semibold tracking-tight">{store.businessName}</h1>
          {(store.city || store.state) && <p className="text-sm text-ink-3">{[store.city, store.state].filter(Boolean).join(', ')}</p>}
          {store.description && <p className="max-w-2xl whitespace-pre-line text-ink-2">{store.description}</p>}
          {store.orderInstructions && <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2"><span className="font-medium">How to order: </span>{store.orderInstructions}</p>}
        </div>
      </section>

      <CodeLookup slug={store.slug} />

      <form action={`/store/${store.slug}`} className="flex gap-2">
        <label className="sr-only" htmlFor="store-search">Search this store</label>
        <input id="store-search" name="q" defaultValue={sp.q} placeholder="Search products" className="h-11 flex-1 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-sm focus:border-[var(--accent)] focus:outline-none" />
        {sp.category && <input type="hidden" name="category" value={sp.category} />}
        <button className="h-11 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-medium text-white">Search</button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Categories" className="flex gap-2 overflow-x-auto pb-1">
          <Link href={link({ category: undefined, page: undefined })} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${!sp.category ? 'border-[var(--accent)] font-medium text-ink' : 'border-line text-ink-2'}`}>All</Link>
          {store.categories.map((c) => (
            <Link key={c.slug} href={link({ category: c.slug, page: undefined })} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-sm ${sp.category === c.slug ? 'border-[var(--accent)] font-medium text-ink' : 'border-line text-ink-2'}`}>{c.name}</Link>
          ))}
        </nav>
        <div className="flex gap-3 text-sm text-ink-3">
          <span>Sort:</span>
          <Link href={link({ sort: undefined, page: undefined })} className={!sp.sort ? 'font-medium text-ink' : 'hover:text-ink'}>Newest</Link>
          <Link href={link({ sort: 'price_asc', page: undefined })} className={sp.sort === 'price_asc' ? 'font-medium text-ink' : 'hover:text-ink'}>Price ↑</Link>
          <Link href={link({ sort: 'price_desc', page: undefined })} className={sp.sort === 'price_desc' ? 'font-medium text-ink' : 'hover:text-ink'}>Price ↓</Link>
        </div>
      </div>

      {products.items.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center">
          <p className="font-medium">{sp.q || sp.category ? 'No products match' : 'No products yet'}</p>
          <p className="mt-1 text-sm text-ink-3">{sp.q || sp.category ? 'Try another search or category.' : 'Check back soon.'}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {products.items.map((p) => (
            <li key={p.slug}>
              <Link href={`/store/${store.slug}/p/${p.slug}`} className="group block overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                <div className="relative aspect-square bg-sunken">
                  {p.imageUrl ? <img src={p.imageUrl} alt={p.name} loading="lazy" className="size-full object-cover transition group-hover:scale-[1.02]" /> : <div className="grid size-full place-items-center text-xs text-ink-4">No photo</div>}
                  {AVAIL[p.availability] && <span className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${p.availability === 'out_of_stock' ? 'bg-ink text-white' : 'bg-warn-bg text-warn'}`}>{AVAIL[p.availability]}</span>}
                </div>
                <div className="p-3">
                  <p className="text-[11px] font-semibold text-ink-3">{p.productCode}</p>
                  <p className="line-clamp-2 text-sm font-medium text-ink">{p.name}</p>
                  <p className="mt-1 tabular"><span className="font-semibold">{formatMoney(p.priceMinor, store.currency)}</span>{p.compareAtMinor && <span className="ml-2 text-[13px] text-ink-4 line-through">{formatMoney(p.compareAtMinor, store.currency)}</span>}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-center gap-4 text-sm">
          {page > 1 ? <Link href={link({ page: String(page - 1) })} className="font-medium text-ink hover:underline">← Previous</Link> : <span className="text-ink-4">← Previous</span>}
          <span className="text-ink-3">Page {page} of {pages}</span>
          {page < pages ? <Link href={link({ page: String(page + 1) })} className="font-medium text-ink hover:underline">Next →</Link> : <span className="text-ink-4">Next →</span>}
        </nav>
      )}
    </div>
  );
}
