import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Empty, ErrorBox, Hero, ListRow, Loading, Screen, SectionTitle, c, type IconName } from '@/components/ui';
import { useApi, useAuth } from '@/lib/auth';
import { money, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Session { id: string; title: string; status: string; scheduledAt: string; channel: { name: string; type?: string }; _count: { orders: number }; paidOrders: number; revenueMinor: string }

const PLATFORM_ICON: Record<string, IconName> = { TIKTOK_LIVE: 'logo-tiktok', INSTAGRAM_LIVE: 'logo-instagram', FACEBOOK_LIVE: 'logo-facebook', YOUTUBE_LIVE: 'logo-youtube', WHATSAPP: 'logo-whatsapp' };
const iconFor = (s: Session): IconName => PLATFORM_ICON[s.channel.type ?? ''] ?? (/tiktok/i.test(s.channel.name) ? 'logo-tiktok' : /insta/i.test(s.channel.name) ? 'logo-instagram' : /face/i.test(s.channel.name) ? 'logo-facebook' : 'radio');

export default function Live() {
  useTheme();
  const { can } = useAuth();
  const upcoming = useApi<{ items: Session[] }>('/live-sessions?when=upcoming&pageSize=20');
  const past = useApi<{ items: Session[] }>('/live-sessions?when=past&pageSize=10');
  const reload = () => { void upcoming.reload(); void past.reload(); };
  if (upcoming.error) return <Screen><ErrorBox message={upcoming.error} onRetry={reload} /></Screen>;
  if (!upcoming.data || !past.data) return <Loading />;
  const liveNow = upcoming.data.items.find((s) => s.status === 'LIVE');
  const row = (s: Session, i: number) => (
    <View key={s.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
      <ListRow onPress={() => router.push(`/live/${s.id}`)} icon={iconFor(s)} iconColor={s.status === 'LIVE' ? c.bad : undefined} title={s.title}
        subtitle={`${s.channel.name} · ${when(s.scheduledAt)} · ${s._count.orders} orders · ${money(s.revenueMinor)} paid`}
        right={<Badge tone={s.status === 'LIVE' ? 'bad' : s.status === 'SCHEDULED' ? 'info' : 'neutral'}>{s.status === 'LIVE' ? '● Live' : s.status.toLowerCase()}</Badge>} />
    </View>
  );
  return (
    <Screen refreshing={upcoming.loading} onRefresh={reload}>
      {liveNow ? (
        <Hero>
          <Text style={{ color: '#fff', fontWeight: '800', letterSpacing: 0.6, fontSize: 12 }}>● YOU’RE LIVE</Text>
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }} numberOfLines={1}>{liveNow.title}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.85)' }}>{liveNow._count.orders} orders · {money(liveNow.revenueMinor)} paid so far</Text>
          <View style={{ marginTop: 6 }}><Button variant="secondary" icon="flash" title="Open the live console" onPress={() => router.push(`/live/${liveNow.id}`)} /></View>
        </Hero>
      ) : can('live:manage') ? <Button title="New live session" icon="radio" onPress={() => router.push('/live/new')} /> : null}
      <SectionTitle>Now and upcoming</SectionTitle>
      {upcoming.data.items.length === 0 ? (
        <Empty icon="radio-outline" title="No live sessions planned" hint={can('live:manage') ? 'Go live now or plan one for later. New to this? The Academy shows you how.' : 'Sessions your team schedules appear here.'}
          action={{ title: 'Learn how to sell live', onPress: () => router.push('/learn') }} />
      ) : <Card style={{ paddingVertical: 4 }}>{upcoming.data.items.map(row)}</Card>}
      {past.data.items.length > 0 ? <><SectionTitle>Recent</SectionTitle><Card style={{ paddingVertical: 4 }}>{past.data.items.map(row)}</Card></> : null}
    </Screen>
  );
}
