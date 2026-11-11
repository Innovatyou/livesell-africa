import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Switch, Text, View } from 'react-native';
import { Avatar, Badge, Button, Card, Hero, ListRow, Muted, Notice, Screen, SectionTitle, c, type IconName } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { WEB_URL } from '@/lib/links';
import * as bio from '@/lib/biometric';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';
import { useTheme } from '@/lib/theme';

interface Link { label: string; hint: string; href: string; icon: IconName; color?: string; permission: string | null }
const GROUPS: Array<{ title: string; links: Link[] }> = [
  { title: 'Learn', links: [
    { label: 'LiveSell Academy', hint: 'Free classes: TikTok, Instagram, Facebook, WhatsApp', href: '/learn', icon: 'school', color: '#6b3fc4', permission: null },
  ] },
  { title: 'Store', links: [
    { label: 'Store settings', hint: 'Name, contacts, pre-orders', href: '/settings/store', icon: 'storefront', permission: 'store:manage' },
    { label: 'Delivery & couriers', hint: 'Zones, pickup, riders', href: '/settings/delivery', icon: 'bicycle', color: '#1d5fa8', permission: 'orders:read' },
    { label: 'Customer messages', hint: 'WhatsApp, SMS and email updates', href: '/settings/messages', icon: 'chatbubbles', color: '#25a35a', permission: 'store:manage' },
    { label: 'Business verification', hint: 'CAC certificate for a verified badge', href: '/verification', icon: 'shield-checkmark', color: '#0e7a4d', permission: 'store:manage' },
  ] },
  { title: 'Money', links: [
    { label: 'Payments & bank accounts', hint: 'Paystack, Flutterwave, Bachs, transfers', href: '/settings/payments', icon: 'card', color: '#b4510f', permission: 'payments:read' },
    { label: 'Analytics', hint: 'Sales, channels, best sellers', href: '/analytics', icon: 'bar-chart', color: '#1d5fa8', permission: 'reports:read' },
    { label: 'Plan & billing', hint: 'Your LiveSell plan and invoices', href: '/billing', icon: 'receipt', color: '#6b3fc4', permission: 'billing:manage' },
  ] },
  { title: 'Team', links: [
    { label: 'Team & roles', hint: 'Invite helpers, choose what they can do', href: '/team', icon: 'people', color: '#b0306b', permission: 'staff:manage' },
  ] },
  { title: 'App', links: [
    { label: 'Appearance', hint: 'Dark mode, colour, 3D cards, start screen', href: '/appearance', icon: 'color-palette', color: '#b0306b', permission: null },
  ] },
];

/** Account, notifications, security, store switcher and every setting, grouped. */
export default function More() {
  useTheme();
  const { me, workspace, selectTenant, logout, can } = useAuth();
  const [bioState, setBio] = useState<{ available: boolean; label: string; on: boolean } | null>(null);
  useEffect(() => { void Promise.all([bio.support(), bio.isEnabled()]).then(([s, on]) => setBio({ ...s, on })); }, []);
  const [push, setPush] = useState<PushState | null>(null);
  useEffect(() => { void pushState().then(setPush); }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webUrl = WEB_URL;

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const sw = { trackColor: { true: c.brand, false: c.line }, thumbColor: c.surface };

  return (
    <Screen>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Hero>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={{ borderRadius: 28, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' }}><Avatar name={me?.fullName ?? '?'} size={52} /></View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }} numberOfLines={1}>{me?.fullName}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.85)' }} numberOfLines={1}>{me?.email}</Text>
            {workspace ? <Text style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }} numberOfLines={1}>{workspace.businessName} · {workspace.role}</Text> : null}
          </View>
        </View>
      </Hero>

      {me && me.memberships.length > 1 ? (
        <>
          <SectionTitle>Your stores</SectionTitle>
          <Card style={{ paddingVertical: 4 }}>
            {me.memberships.map((m, i) => (
              <View key={m.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
                <ListRow icon="storefront" title={m.tenant.businessName} subtitle={busy === m.id ? 'Switching…' : m.role.name}
                  right={m.tenant.id === workspace?.id ? <Badge tone="good">Current</Badge> : undefined}
                  onPress={m.tenant.id === workspace?.id || busy !== null ? undefined : () => void act(m.id, () => selectTenant(m.tenant.id))} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {GROUPS.map((g) => {
        const links = g.links.filter((l) => !l.permission || can(l.permission));
        if (!links.length) return null;
        return (
          <View key={g.title} style={{ gap: 8 }}>
            <SectionTitle>{g.title}</SectionTitle>
            <Card style={{ paddingVertical: 4 }}>
              {links.map((l, i) => (
                <View key={l.href} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
                  <ListRow icon={l.icon} iconColor={l.color} title={l.label} subtitle={l.hint} onPress={() => router.push(l.href as never)} />
                </View>
              ))}
            </Card>
          </View>
        );
      })}

      <SectionTitle>This phone</SectionTitle>
      <Card style={{ paddingVertical: 4 }}>
        <ListRow icon="notifications" iconColor="#b4510f" title="Notifications"
          subtitle={push?.status === 'denied' ? 'Blocked: allow them in your phone settings' : push?.status === 'unavailable' ? `Not available in this build` : 'New orders and transfers to check'}
          right={<Switch value={push?.status === 'on'} disabled={busy === 'push'} {...sw} accessibilityLabel="Notifications on this phone"
            onValueChange={(v) => void act('push', async () => { if (v) setPush(await enablePush()); else { await disablePush(); setPush({ status: 'off' }); } })} />} />
        <View style={{ borderTopWidth: 1, borderTopColor: c.line }}>
          <ListRow icon="finger-print" iconColor="#0e7a4d" title={`Unlock with ${bioState?.label ?? 'fingerprint'}`}
            subtitle={bioState && !bioState.available ? 'Set up a fingerprint or face unlock on your phone first' : 'Asks again after 5 minutes away. No password stored'}
            right={<Switch value={!!bioState?.on} disabled={!bioState?.available || busy === 'bio'} {...sw} accessibilityLabel={`Unlock with ${bioState?.label ?? 'fingerprint'}`}
              onValueChange={(v) => void act('bio', async () => {
                // Turning it on needs a successful scan first, so someone holding an unlocked phone can't enable it.
                const ok = v ? await bio.authenticate(`Confirm your ${bioState?.label ?? 'fingerprint'}`) : true;
                if (!ok) return;
                await bio.setEnabled(v);
                setBio((b) => (b ? { ...b, on: v } : b));
              })} />} />
        </View>
      </Card>

      <Card style={{ paddingVertical: 4 }}>
        <ListRow icon="desktop-outline" title="Open LiveSell on the web" subtitle="Bigger screen for CSV import and printing invoices" onPress={() => void Linking.openURL(webUrl)} />
      </Card>
      <Button variant="danger" icon="log-out-outline" title="Sign out" loading={busy === 'logout'} onPress={() => void act('logout', logout)} />
      <Muted>LiveSell {Constants.expoConfig?.version ?? '1.0.0'}</Muted>
    </Screen>
  );
}
