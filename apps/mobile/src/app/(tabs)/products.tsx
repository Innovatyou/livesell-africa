import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Chips, Empty, ErrorBox, ListRow, Loading, Muted, Screen, SearchBar, c } from '@/components/ui';
import { useApi, useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Product { id: string; name: string; productCode: string; status: string; priceMin: string | null; priceMax: string | null; available: number; lowStock: boolean; outOfStock: boolean }
type StockView = '' | 'low' | 'out';

/** Stock at a glance; tap a product to edit it, its photos and its stock. */
export default function Products() {
  useTheme();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [stock, setStock] = useState<StockView>('');
  const res = useApi<{ items: Product[]; total: number }>(`/products?pageSize=50${query ? `&search=${encodeURIComponent(query)}` : ''}${stock ? `&stock=${stock}` : ''}`);
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      {can('products:write') ? <Button title="Add product" icon="add" onPress={() => router.push('/products/new')} /> : null}
      <SearchBar value={search} onChangeText={setSearch} onSubmit={setQuery} placeholder="Name or code (BAG001)" />
      <Chips label="Stock filter" value={stock} onChange={setStock} options={[['', 'All'], ['low', 'Running low'], ['out', 'Sold out']]} />
      {res.error ? <ErrorBox message={res.error} onRetry={res.reload} />
        : !res.data ? <Loading />
        : res.data.items.length === 0 ? (
          <Empty icon="cube-outline" title={query || stock ? 'Nothing matches' : 'No products yet'} hint={query || stock ? undefined : 'Add your best sellers first. The code (BAG001) is made from the name.'}
            action={can('products:write') && !query && !stock ? { title: 'Add your first product', onPress: () => router.push('/products/new') } : undefined} />
        ) : (
          <>
            <Muted>{res.data.total} product{res.data.total === 1 ? '' : 's'}</Muted>
            <Card style={{ paddingVertical: 4 }}>
              {res.data.items.map((p, i) => (
                <View key={p.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
                  <ListRow onPress={() => router.push(`/products/${p.id}`)} icon={p.outOfStock ? 'alert-circle' : 'cube'} iconColor={p.outOfStock ? c.bad : p.lowStock ? c.warn : c.brand}
                    title={p.name} subtitle={`${p.productCode} · ${p.priceMin === null ? '—' : p.priceMin === p.priceMax ? money(p.priceMin) : `${money(p.priceMin)} – ${money(p.priceMax)}`}${p.status !== 'ACTIVE' ? ' · hidden' : ''}`}
                    right={<Badge tone={p.outOfStock ? 'bad' : p.lowStock ? 'warn' : 'good'}>{p.outOfStock ? 'Sold out' : `${p.available} left`}</Badge>} />
                </View>
              ))}
            </Card>
          </>
        )}
      {res.data && res.data.items.length > 0 ? <Text style={{ color: c.ink3, fontSize: 12 }}>Tap a product to change its price, photos or stock.</Text> : null}
    </Screen>
  );
}
