import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Card, Empty, ErrorBox, Loading, Muted, Row, Screen, c } from '@/components/ui';
import { useApi } from '@/lib/auth';
import { money } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Report {
  currency: string; range: { from: string; to: string };
  overview: { orders: number; paidOrders: number; grossSalesMinor: string; netSalesMinor: string; averageOrderValueMinor: string; unitsSold: number; paymentCompletionBps: number | null; newCustomers: number; liveSessions: number };
  comparison: { grossSalesMinor: { changeBps: number | null }; orders: { changeBps: number | null } };
  channels: Array<{ channelId: string | null; name: string; orders: number; grossSalesMinor: string }>;
  sessions: Array<{ id: string; title: string; orders: number; grossSalesMinor: string; conversionBps: number | null }>;
  topProducts: Array<{ productId: string; name: string; productCode: string; unitsSold: number }>;
}
const lagosDay = (d: Date) => new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
const PRESETS: Array<[number, string]> = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const rate = (b: number | null) => (b === null ? '—' : `${(b / 100).toFixed(1)}%`);
const change = (b: number | null) => (b === null ? '' : ` (${b >= 0 ? '+' : '−'}${(Math.abs(b) / 100).toFixed(0)}%)`);

/** Sales analytics (Professional plan and up), compared with the period before. Real data only. */
export default function Analytics() {
  useTheme();
  const [days, setDays] = useState(30);
  const now = new Date();
  const res = useApi<Report>(`/analytics?from=${lagosDay(new Date(now.getTime() - (days - 1) * 86_400_000))}&to=${lagosDay(now)}`);
  const tile = (label: string, value: string) => <Card key={label} style={{ flexBasis: '48%', flexGrow: 1, gap: 2 }}><Muted>{label}</Muted><Text style={{ fontSize: 18, fontWeight: '700', color: c.ink }}>{value}</Text></Card>;
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
        {PRESETS.map(([d, l]) => (
          <Pressable key={d} onPress={() => setDays(d)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: days === d ? c.brand : c.line, backgroundColor: days === d ? c.brandSoft : c.surface }}>
            <Text style={{ color: days === d ? c.brand : c.ink2 }}>{l}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {res.error ? <ErrorBox message={res.error} onRetry={res.reload} /> : !res.data ? <Loading /> : (() => {
        const r = res.data;
        const o = r.overview;
        if (o.orders === 0) return <Empty title="No orders in this period" />;
        return (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              {tile('Gross sales', money(o.grossSalesMinor, r.currency) + change(r.comparison.grossSalesMinor.changeBps))}
              {tile('Net sales', money(o.netSalesMinor, r.currency))}
              {tile('Orders', `${o.orders} (${o.paidOrders} paid)` + change(r.comparison.orders.changeBps))}
              {tile('Average order', money(o.averageOrderValueMinor, r.currency))}
              {tile('Payment completion', rate(o.paymentCompletionBps))}
              {tile('New customers', String(o.newCustomers))}
            </View>
            <Card style={{ gap: 6 }}><Text style={{ fontWeight: '700', color: c.ink }}>Channels</Text>
              {r.channels.map((ch) => <Row key={ch.channelId ?? 'none'}><Text style={{ color: c.ink }}>{ch.name}</Text><Muted>{ch.orders} orders · {money(ch.grossSalesMinor, r.currency)}</Muted></Row>)}</Card>
            <Card style={{ gap: 6 }}><Text style={{ fontWeight: '700', color: c.ink }}>Live sessions</Text>
              {r.sessions.length === 0 ? <Muted>No lives in this period.</Muted> : r.sessions.map((s) => <Row key={s.id}><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}>{s.title}</Text><Muted>{s.orders} · {money(s.grossSalesMinor, r.currency)}{s.conversionBps !== null ? ` · ${rate(s.conversionBps)}` : ''}</Muted></Row>)}</Card>
            <Card style={{ gap: 6 }}><Text style={{ fontWeight: '700', color: c.ink }}>Top products</Text>
              {r.topProducts.map((p) => <Row key={p.productId}><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}>{p.productCode} · {p.name}</Text><Muted>{p.unitsSold} sold</Muted></Row>)}</Card>
          </>
        );
      })()}
    </Screen>
  );
}
