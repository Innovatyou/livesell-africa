import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput } from 'react-native';
import { Badge, Card, Empty, ErrorBox, Loading, Muted, Row, Screen, c } from '@/components/ui';
import { useApi } from '@/lib/auth';
import { holdLabel, money, ORDER_STATUS, when } from '@/lib/format';

interface Item { id: string; reference: string; status: string; totalMinor: string; currency: string; createdAt: string; reservationExpiresAt: string | null; customer: { fullName: string; phone: string | null } | null; liveSession: { title: string } | null }
const VIEWS: Array<[string, string]> = [['', 'All'], ['awaiting_payment', 'Awaiting payment'], ['to_fulfil', 'To fulfil'], ['completed', 'Delivered'], ['cancelled', 'Cancelled']];

export default function Orders() {
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState(params.view ?? '');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const qs = new URLSearchParams({ pageSize: '50', ...(view ? { view } : {}), ...(query ? { search: query } : {}) }).toString();
  const res = useApi<{ items: Item[]; total: number }>(`/orders?${qs}`);
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {VIEWS.map(([k, l]) => (
          <Pressable key={k} onPress={() => setView(k)} accessibilityRole="tab" accessibilityState={{ selected: view === k }}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: view === k ? c.brand : c.line, backgroundColor: view === k ? c.brandSoft : c.surface }}>
            <Text style={{ color: view === k ? c.brand : c.ink2, fontWeight: view === k ? '600' : '400' }}>{l}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <TextInput placeholder="Search order no., customer or phone" placeholderTextColor={c.ink3} value={search} onChangeText={setSearch} onSubmitEditing={() => setQuery(search.trim())} returnKeyType="search" accessibilityLabel="Search orders"
        style={{ minHeight: 44, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 12, backgroundColor: c.surface, color: c.ink }} />
      {res.error ? <ErrorBox message={res.error} onRetry={res.reload} /> : !res.data ? <Loading /> : res.data.items.length === 0 ? <Empty title="No orders here" hint="Orders from the live, WhatsApp and your store page show up here." /> : res.data.items.map((o) => {
        const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
        const hold = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(o.status) ? holdLabel(o.reservationExpiresAt) : null;
        return (
          <Pressable key={o.id} onPress={() => router.push(`/orders/${o.id}`)}>
            <Card style={{ gap: 4 }}>
              <Row><Text style={{ fontWeight: '700', color: c.ink }}>{o.reference}</Text><Text style={{ color: c.ink, fontWeight: '600' }}>{money(o.totalMinor, o.currency)}</Text></Row>
              <Row><Muted>{o.customer?.fullName ?? 'No customer'}{o.liveSession ? ` · ${o.liveSession.title}` : ''}</Muted><Badge tone={st.tone}>{st.label}</Badge></Row>
              <Muted>{when(o.createdAt)}{hold ? ` · ${hold}` : ''}</Muted>
            </Card>
          </Pressable>
        );
      })}
    </Screen>
  );
}
