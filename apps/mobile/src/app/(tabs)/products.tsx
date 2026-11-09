import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Muted, Row, Screen, c } from '@/components/ui';
import { useApi, useAuth } from '@/lib/auth';
import { money } from '@/lib/format';

interface Product { id: string; name: string; productCode: string; status: string; priceMin: string | null; priceMax: string | null; available: number; lowStock: boolean; outOfStock: boolean }

/** Stock at a glance; tap a product to edit it, its photos and its stock. */
export default function Products() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const res = useApi<{ items: Product[]; total: number }>(`/products?pageSize=50${query ? `&search=${encodeURIComponent(query)}` : ''}`);
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      {can('products:write') ? <Button title="Add product" onPress={() => router.push('/products/new')} /> : null}
      <TextInput placeholder="Search name or code (BAG001)" placeholderTextColor={c.ink3} value={search} onChangeText={setSearch} onSubmitEditing={() => setQuery(search.trim())} returnKeyType="search" accessibilityLabel="Search products"
        style={{ minHeight: 44, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 12, backgroundColor: c.surface, color: c.ink }} />
      {res.error ? <ErrorBox message={res.error} onRetry={res.reload} /> : !res.data ? <Loading /> : res.data.items.length === 0 ? <Empty title="No products found" hint="Add your first product above." /> : res.data.items.map((p) => (
        <Pressable key={p.id} onPress={() => router.push(`/products/${p.id}`)}><Card style={{ gap: 4 }}>
          <Row><Text style={{ color: c.ink, fontWeight: '600', flex: 1 }} numberOfLines={1}>{p.productCode} · {p.name}</Text>
            <Badge tone={p.outOfStock ? 'bad' : p.lowStock ? 'warn' : 'good'}>{p.outOfStock ? 'Sold out' : `${p.available} left`}</Badge></Row>
          <Muted>{p.priceMin === null ? '—' : p.priceMin === p.priceMax ? money(p.priceMin) : `${money(p.priceMin)} – ${money(p.priceMax)}`}</Muted>
        </Card></Pressable>
      ))}
    </Screen>
  );
}
