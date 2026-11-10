import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar, Badge, Card, Chips, Empty, ErrorBox, ListRow, Loading, Muted, Screen, SearchBar, c } from '@/components/ui';
import { useApi, useAuth } from '@/lib/auth';
import { holdLabel, money, ORDER_STATUS, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Item { id: string; reference: string; status: string; totalMinor: string; currency: string; createdAt: string; reservationExpiresAt: string | null; customer: { fullName: string; phone: string | null } | null; liveSession: { title: string } | null }
const VIEWS: Array<[string, string]> = [['', 'All'], ['awaiting_payment', 'Awaiting payment'], ['to_fulfil', 'To fulfil'], ['completed', 'Delivered'], ['cancelled', 'Cancelled']];

export default function Orders() {
  useTheme();
  const { can } = useAuth();
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState(params.view ?? '');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const qs = new URLSearchParams({ pageSize: '50', ...(view ? { view } : {}), ...(query ? { search: query } : {}) }).toString();
  const res = useApi<{ items: Item[]; total: number }>(`/orders?${qs}`);
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      <SearchBar value={search} onChangeText={setSearch} onSubmit={() => setQuery(search.trim())} placeholder="Order no., customer or phone" />
      <Chips label="Order views" value={view} onChange={setView} options={VIEWS} />
      {res.error ? <ErrorBox message={res.error} onRetry={res.reload} />
        : !res.data ? <Loading />
        : res.data.items.length === 0 ? (
          <Empty icon="receipt-outline" title={query ? 'No orders match' : 'No orders here yet'} hint="Orders from your lives, WhatsApp and your store page show up here."
            action={can('live:manage') && !query && !view ? { title: 'Start a live session', onPress: () => router.push('/live/new') } : undefined} />
        ) : (
          <>
            <Muted>{res.data.total} order{res.data.total === 1 ? '' : 's'}</Muted>
            <Card style={{ gap: 0, paddingVertical: 4 }}>
              {res.data.items.map((o, i) => {
                const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
                const hold = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(o.status) ? holdLabel(o.reservationExpiresAt) : null;
                return (
                  <View key={o.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
                    <ListRow onPress={() => router.push(`/orders/${o.id}`)} left={<Avatar name={o.customer?.fullName ?? o.reference} />}
                      title={o.customer?.fullName ?? 'No customer'}
                      subtitle={`${o.reference}${o.liveSession ? ` · ${o.liveSession.title}` : ''} · ${when(o.createdAt)}${hold ? ` · ${hold}` : ''}`}
                      right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Text style={{ color: c.ink, fontWeight: '800' }}>{money(o.totalMinor, o.currency)}</Text><Badge tone={st.tone}>{st.label}</Badge></View>} />
                  </View>
                );
              })}
            </Card>
          </>
        )}
    </Screen>
  );
}
