import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { Badge, Card, Empty, ErrorBox, Loading, Muted, Row, Screen, c } from '@/components/ui';
import { useApi } from '@/lib/auth';
import { money, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Session { id: string; title: string; status: string; scheduledAt: string; channel: { name: string }; _count: { orders: number }; paidOrders: number; revenueMinor: string }

export default function Live() {
  useTheme();
  const upcoming = useApi<{ items: Session[] }>('/live-sessions?when=upcoming&pageSize=20');
  const past = useApi<{ items: Session[] }>('/live-sessions?when=past&pageSize=10');
  const reload = () => { void upcoming.reload(); void past.reload(); };
  const row = (s: Session) => (
    <Pressable key={s.id} onPress={() => router.push(`/live/${s.id}`)}>
      <Card style={{ gap: 4 }}>
        <Row><Text style={{ fontWeight: '700', color: c.ink, flex: 1 }} numberOfLines={1}>{s.title}</Text><Badge tone={s.status === 'LIVE' ? 'bad' : s.status === 'SCHEDULED' ? 'info' : 'neutral'}>{s.status === 'LIVE' ? '● Live' : s.status.toLowerCase()}</Badge></Row>
        <Muted>{s.channel.name} · {when(s.scheduledAt)} · {s._count.orders} orders · {money(s.revenueMinor)} paid</Muted>
      </Card>
    </Pressable>
  );
  if (upcoming.error) return <Screen><ErrorBox message={upcoming.error} onRetry={reload} /></Screen>;
  if (!upcoming.data || !past.data) return <Loading />;
  return (
    <Screen refreshing={upcoming.loading} onRefresh={reload}>
      <Text style={{ fontWeight: '700', color: c.ink }}>Now and upcoming</Text>
      {upcoming.data.items.length === 0 ? <Empty title="No live sessions scheduled" hint="Schedule one on the web, then run it from here." /> : upcoming.data.items.map(row)}
      {past.data.items.length > 0 ? <Text style={{ fontWeight: '700', color: c.ink, marginTop: 8 }}>Recent</Text> : null}
      {past.data.items.map(row)}
    </Screen>
  );
}
