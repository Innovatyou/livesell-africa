import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, Switch, Text } from 'react-native';
import { Badge, Button, Card, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import * as bio from '@/lib/biometric';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';
import { useTheme } from '@/lib/theme';

const LINKS = [
  { label: 'Store settings', href: '/settings/store', permission: 'store:manage' },
  { label: 'Business verification (CAC)', href: '/verification', permission: 'store:manage' },
  { label: 'Team & roles', href: '/team', permission: 'staff:manage' },
  { label: 'Payments & bank accounts', href: '/settings/payments', permission: 'payments:read' },
  { label: 'Customer messages', href: '/settings/messages', permission: 'store:manage' },
  { label: 'Delivery & couriers', href: '/settings/delivery', permission: 'orders:read' },
  { label: 'Analytics', href: '/analytics', permission: 'reports:read' },
  { label: 'Plan & billing', href: '/billing', permission: 'billing:manage' },
  { label: 'Appearance (theme, colour, 3D)', href: '/appearance', permission: null },
];

/** Account, notifications, store switcher, settings, and the way to the full web app. */
export default function More() {
  useTheme();
  const { me, workspace, selectTenant, logout, can } = useAuth();
  const [bioState, setBio] = useState<{ available: boolean; label: string; on: boolean } | null>(null);
  useEffect(() => { void Promise.all([bio.support(), bio.isEnabled()]).then(([s, on]) => setBio({ ...s, on })); }, []);
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
      <Card style={{ gap: 8 }}>
        <Row><Text style={{ color: c.ink, flex: 1 }}>Unlock with {bioState?.label ?? 'fingerprint'}</Text>
          <Switch value={!!bioState?.on} disabled={!bioState?.available || busy === 'bio'} trackColor={{ true: c.brand, false: c.line }} thumbColor={c.surface}
            accessibilityLabel={`Unlock with ${bioState?.label ?? 'fingerprint'}`}
            onValueChange={(v) => void act('bio', async () => {
              // Turning it on needs a successful scan first, so it can't be enabled by someone holding an unlocked phone without the owner's finger.
              const ok = v ? await bio.authenticate(`Confirm your ${bioState?.label ?? 'fingerprint'}`) : true;
              if (!ok) return;
              await bio.setEnabled(v);
              setBio((b) => (b ? { ...b, on: v } : b));
            })} /></Row>
        <Muted>{bioState && !bioState.available ? 'Set up a fingerprint or face unlock in your phone settings to use this.' : 'Opens the app with your fingerprint or face; asks again after 5 minutes away. Your password is never stored.'}</Muted>
      </Card>
      <Card style={{ gap: 4 }}>
        {LINKS.filter((l) => !l.permission || can(l.permission)).map((l) => (
          <Pressable key={l.href} onPress={() => router.push(l.href as never)} accessibilityRole="link" style={{ paddingVertical: 10 }}>
            <Row><Text style={{ color: c.ink }}>{l.label}</Text><Text style={{ color: c.ink3 }}>›</Text></Row>
          </Pressable>
        ))}
      </Card>
      <Card style={{ gap: 8 }}>
        <Muted>Everything is in this app. The web app is there if you prefer a bigger screen (CSV import, printing invoices).</Muted>
        <Button variant="secondary" title="Open LiveSell on the web" onPress={() => void Linking.openURL(webUrl)} />
      </Card>
      <Button variant="danger" title="Sign out" loading={busy === 'logout'} onPress={() => void act('logout', logout)} />
      <Muted>Version {Constants.expoConfig?.version ?? '1.0.0'}</Muted>
    </Screen>
  );
}
