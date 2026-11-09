import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProductBuyBox } from '@/components/store/product-buy-box';
import { fetchProduct, fetchStore, fetchWhatsappOrdering } from '@/lib/storefront';

type Params = Promise<{ slug: string; productSlug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, productSlug } = await params;
  const p = await fetchProduct(slug, productSlug).catch(() => null);
  if (!p) return { title: 'Product not found' };
  const image = p.media.find((m) => m.type === 'image')?.url;
  return { title: p.name, description: p.description?.slice(0, 160) ?? undefined, openGraph: { title: p.name, images: image ? [image] : undefined } };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { slug, productSlug } = await params;
  const [store, product, ordering] = await Promise.all([fetchStore(slug), fetchProduct(slug, productSlug), fetchWhatsappOrdering(slug)]);
  if (!store || !product) notFound();
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-ink-3">
        <Link href={`/store/${store.slug}`} className="hover:text-ink">{store.businessName}</Link>
        {product.category && <> <span aria-hidden>›</span> <Link href={`/store/${store.slug}?category=${product.category.slug}`} className="hover:text-ink">{product.category.name}</Link></>}
      </nav>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          {product.media.length === 0 ? <div className="grid aspect-square place-items-center rounded-[var(--radius-card)] bg-sunken text-sm text-ink-4">No photo</div>
            : product.media.map((m, i) => (
              <div key={m.url} className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                {m.type === 'image'
                  ? <img src={m.url} alt={m.alt} loading={i === 0 ? 'eager' : 'lazy'} className="aspect-square w-full object-cover" />
                  : <video src={m.url} controls playsInline preload="metadata" className="aspect-square w-full bg-ink object-contain" />}
              </div>
            ))}
        </div>
        <div className="space-y-4 md:sticky md:top-20 md:self-start">
          <div>
            <p className="text-[12px] font-semibold tracking-wide text-ink-3">CODE {product.productCode}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{product.name}</h1>
          </div>
          <ProductBuyBox store={store} product={product} ordering={ordering} />
          {product.description && <div className="whitespace-pre-line border-t border-line pt-4 leading-relaxed text-ink-2">{product.description}</div>}
          {store.orderInstructions && <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2"><span className="font-medium">How to order: </span>{store.orderInstructions}</p>}
        </div>
      </div>
    </div>
  );
}
