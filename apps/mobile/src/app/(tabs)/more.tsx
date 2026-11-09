import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, Switch, Text } from 'react-native';
import { Badge, Button, Card, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';

const LINKS = [
  { label: 'Store settings', href: '/settings/store', permission: 'store:manage' },
  { label: 'Business verification (CAC)', href: '/verification', permission: 'store:manage' },
  { label: 'Delivery & couriers', href: '/settings/delivery', permission: 'orders:read' },
  { label: 'Analytics', href: '/analytics', permission: 'reports:read' },
  { label: 'Plan & billing', href: '/billing', permission: 'billing:manage' },
];

/** Account, notifications, store switcher, settings, and the way to the full web app. */
export default function More() {
  const { me, workspace, selectTenant, logout, can } = useAuth();
  const [push, setPush] = useState<PushState | null>(null);
  useEffect(() => { void pushState().then(setPush); }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webUrl = (Constants.expoConfig?.extra?.webUrl as string | undefined) ?? 'https://app.livesell.africa';

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

  return (
    <Screen>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Card style={{ gap: 4 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>{me?.fullName}</Text>
        <Muted>{me?.email}</Muted>
        {workspace ? <Muted>{workspace.businessName} · {workspace.role}</Muted> : null}
      </Card>
      {me && me.memberships.length > 1 ? (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>Your stores</Text>
          {me.memberships.map((m) => (
            <Pressable key={m.id} disabled={busy !== null || m.tenant.id === workspace?.id} onPress={() => void act(m.id, () => selectTenant(m.tenant.id))} accessibilityRole="button">
              <Row><Text style={{ color: c.ink }}>{m.tenant.businessName}</Text>{m.tenant.id === workspace?.id ? <Badge tone="good">Current</Badge> : <Muted>{busy === m.id ? 'Switching…' : m.role.name}</Muted>}</Row>
            </Pressable>
          ))}
        </Card>
      ) : null}
      <Card style={{ gap: 8 }}>
        <Row><Text style={{ color: c.ink, flex: 1 }}>Notifications on this phone</Text>
          <Switch value={push?.status === 'on'} disabled={busy === 'push'} onValueChange={(v) => void act('push', async () => { if (v) setPush(await enablePush()); else { await disablePush(); setPush({ status: 'off' }); } })} /></Row>
        <Muted>{push?.status === 'denied' ? 'Notifications are blocked: allow them for LiveSell in your phone settings.' : push?.status === 'unavailable' ? `Not available in this build: ${push.reason}` : 'New orders and bank transfers to check, straight to your phone.'}</Muted>
      </Card>
      <Card style={{ gap: 4 }}>
        {LINKS.filter((l) => can(l.permission)).map((l) => (
          <Pressable key={l.href} onPress={() => router.push(l.href as never)} accessibilityRole="link" style={{ paddingVertical: 10 }}>
            <Row><Text style={{ color: c.ink }}>{l.label}</Text><Text style={{ color: c.ink3 }}>›</Text></Row>
          </Pressable>
        ))}
      </Card>
      <Card style={{ gap: 8 }}>
        <Muted>Payment gateways, team, verification and advanced settings are on the web app.</Muted>
        <Button variant="secondary" title="Open LiveSell on the web" onPress={() => void Linking.openURL(webUrl)} />
      </Card>
      <Button variant="danger" title="Sign out" loading={busy === 'logout'} onPress={() => void act('logout', logout)} />
      <Muted>Version {Constants.expoConfig?.version ?? '1.0.0'}</Muted>
    </Screen>
  );
}
