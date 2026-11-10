import { router, useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, Empty, ErrorBox, Hero, Icon, IconBadge, ListRow, Loading, Muted, Progress, Screen, SectionTitle, StatTile, c, type IconName } from '@/components/ui';
import { useAcademy } from '@/lib/academy-progress';
import { useApi, useAuth } from '@/lib/auth';
import { money, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Summary {
  currency: string; salesTodayMinor: string; salesThisMonthMinor: string; totalOrders: number; paidOrders: number;
  pendingPayments: { count: number; amountMinor: string }; outstandingOrders: number; averageOrderValueMinor: string; productsSold: number;
  topProducts: Array<{ productId: string; name: string; productCode: string; quantity: string }>;
  recentTransactions: Array<{ id: string; grossMinor: string; currency: string; status: string; createdAt: string; order: { id: string; reference: string } | null }>;
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

/** MASTER-SPEC §7 dashboard, the seller's “today” view. Real data only. */
export default function Today() {
  useTheme();
  const { can, me } = useAuth();
  const res = useApi<Summary>(can('reports:read') ? '/dashboard/summary' : null);
  const academy = useAcademy();
  useFocusEffect(academy.reload);
  const first = me?.fullName.split(' ')[0] ?? '';

  const all: Array<{ icon: IconName; label: string; href: string; ok: boolean }> = [
    { icon: 'radio', label: 'Go live', href: '/live/new', ok: can('live:manage') },
    { icon: 'add-circle', label: 'Add product', href: '/products/new', ok: can('products:write') },
    { icon: 'receipt', label: 'Orders', href: '/orders', ok: can('orders:read') },
    { icon: 'school', label: 'Learn', href: '/learn', ok: true },
  ];
  const actions = all.filter((a) => a.ok);

  const header = (
    <Hero>
      <Text style={{ color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>{greeting()}{first ? `, ${first}` : ''} 👋</Text>
      {res.data ? (
        <>
          <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 4 }}>Sales today</Text>
          <Text style={{ color: '#fff', fontSize: 32, fontWeight: '900', letterSpacing: -0.5 }} adjustsFontSizeToFit numberOfLines={1}>{money(res.data.salesTodayMinor, res.data.currency)}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.8)' }}>This month {money(res.data.salesThisMonthMinor, res.data.currency)} · {res.data.paidOrders} paid orders</Text>
        </>
      ) : <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>Ready to sell?</Text>}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        {actions.map((a) => (
          <Pressable key={a.href} onPress={() => router.push(a.href as never)} accessibilityRole="button" accessibilityLabel={a.label}
            style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 6, paddingVertical: 10, borderRadius: 14, backgroundColor: pressed ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.16)' })}>
            <Icon name={a.icon} size={22} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
    </Hero>
  );

  const learnCard = academy.completed < academy.total ? (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <IconBadge name="school" size={44} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.ink, fontWeight: '800', fontSize: 15 }}>{academy.completed === 0 ? 'New to live selling?' : 'Keep learning'}</Text>
          <Muted>{academy.next ? `Next: ${academy.next.title} (${academy.next.minutes} min)` : ''}</Muted>
        </View>
      </View>
      <Progress value={academy.completed / academy.total} label={`Academy: ${academy.completed} of ${academy.total} lessons`} />
      <Button title={academy.completed === 0 ? 'Start the free classes' : 'Continue learning'} icon="play" onPress={() => router.push(academy.next ? `/learn/${academy.next.id}` : '/learn')} />
    </Card>
  ) : null;

  if (!can('reports:read')) return <Screen>{header}{learnCard}<Empty title="Your role can’t see sales figures" hint="Use Orders and Live to work." icon="lock-closed-outline" /></Screen>;
  if (res.error) return <Screen>{header}<ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!res.data) return <Loading />;
  const d = res.data;
  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      {header}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <StatTile icon="time" tint="#b4510f" label="Awaiting payment" value={String(d.pendingPayments.count)} hint={money(d.pendingPayments.amountMinor, d.currency)} onPress={() => router.push('/orders?view=awaiting_payment')} />
        <StatTile icon="cube" tint="#1d5fa8" label="To fulfil" value={String(d.outstandingOrders)} onPress={() => router.push('/orders?view=to_fulfil')} />
        <StatTile icon="checkmark-done" tint="#0e7a4d" label="Paid orders" value={String(d.paidOrders)} />
        <StatTile icon="pricetag" tint="#6b3fc4" label="Average order" value={money(d.averageOrderValueMinor, d.currency)} />
      </View>
      {learnCard}
      <SectionTitle action={can('reports:read') ? { title: 'Analytics', onPress: () => router.push('/analytics') } : undefined}>Top products</SectionTitle>
      <Card style={{ gap: 2 }}>
        {d.topProducts.length === 0 ? <Muted>No paid sales yet. Your best sellers show up here.</Muted> : d.topProducts.map((p, i) => (
          <ListRow key={p.productId} title={p.name} subtitle={p.productCode}
            left={<View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: c.brandSoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: c.brand, fontWeight: '900' }}>{i + 1}</Text></View>}
            right={<Text style={{ color: c.ink, fontWeight: '700' }}>{p.quantity} sold</Text>} />
        ))}
      </Card>
      <SectionTitle>Recent payments</SectionTitle>
      <Card style={{ gap: 2 }}>
        {d.recentTransactions.length === 0 ? <Muted>No payments yet.</Muted> : d.recentTransactions.map((t) => (
          <ListRow key={t.id} icon={t.status === 'SUCCEEDED' ? 'checkmark-circle' : 'hourglass'} iconColor={t.status === 'SUCCEEDED' ? c.good : c.warn}
            title={t.order?.reference ?? 'Payment'} subtitle={`${t.status.toLowerCase()} · ${when(t.createdAt)}`}
            right={<Text style={{ color: c.ink, fontWeight: '700' }}>{money(t.grossMinor, t.currency)}</Text>}
            onPress={t.order ? () => router.push(`/orders/${t.order!.id}`) : undefined} />
        ))}
      </Card>
    </Screen>
  );
}
