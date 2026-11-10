import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Card, Empty, ErrorBox, Loading, Muted, Row, Screen, c } from '@/components/ui';
import { useApi, useAuth } from '@/lib/auth';
import { money, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Summary {
  currency: string; salesTodayMinor: string; salesThisMonthMinor: string; totalOrders: number; paidOrders: number;
  pendingPayments: { count: number; amountMinor: string }; outstandingOrders: number; averageOrderValueMinor: string; productsSold: number;
  topProducts: Array<{ productId: string; name: string; productCode: string; quantity: string }>;
  recentTransactions: Array<{ id: string; grossMinor: string; currency: string; status: string; createdAt: string; order: { id: string; reference: string } | null }>;
}

/** MASTER-SPEC §7 dashboard, the seller's “today” view. Real data only. */
export default function Today() {
  useTheme();
  const { can } = useAuth();
  const res = useApi<Summary>(can('reports:read') ? '/dashboard/summary' : null);
  if (!can('reports:read')) return <Screen><Empty title="Your role can’t see sales figures" hint="Use Orders and Live to work." /></Screen>;
  if (res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!res.data) return <Loading />;
  const d = res.data;
  const tile = (label: string, value: string, onPress?: () => void) => (
    <Pressable key={label} onPress={onPress} disabled={!onPress} style={{ flexBasis: '48%', flexGrow: 1 }}>
      <Card style={{ gap: 4 }}><Muted>{label}</Muted><Text style={{ fontSize: 20, fontWeight: '700', color: c.ink }}>{value}</Text></Card>
    </Pressable>
  );
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {tile('Sales today', money(d.salesTodayMinor, d.currency))}
        {tile('This month', money(d.salesThisMonthMinor, d.currency))}
        {tile('Awaiting payment', `${d.pendingPayments.count} · ${money(d.pendingPayments.amountMinor, d.currency)}`, () => router.push('/orders?view=awaiting_payment'))}
        {tile('To fulfil', String(d.outstandingOrders), () => router.push('/orders?view=to_fulfil'))}
        {tile('Paid orders', String(d.paidOrders))}
        {tile('Average order', money(d.averageOrderValueMinor, d.currency))}
      </View>
      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Top products</Text>
        {d.topProducts.length === 0 ? <Muted>No paid sales yet.</Muted> : d.topProducts.map((p) => (
          <Row key={p.productId}><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}>{p.productCode} · {p.name}</Text><Muted>{p.quantity} sold</Muted></Row>
        ))}
      </Card>
      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Recent payments</Text>
        {d.recentTransactions.length === 0 ? <Muted>No payments yet.</Muted> : d.recentTransactions.map((t) => (
          <Pressable key={t.id} onPress={() => t.order && router.push(`/orders/${t.order.id}`)}>
            <Row><Text style={{ color: c.ink }}>{t.order?.reference ?? '—'} · {t.status.toLowerCase()}</Text><Text style={{ color: c.ink }}>{money(t.grossMinor, t.currency)}</Text></Row>
            <Muted>{when(t.createdAt)}</Muted>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}
