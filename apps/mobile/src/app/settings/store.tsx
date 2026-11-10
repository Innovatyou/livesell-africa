import { useEffect, useState } from 'react';
import { Switch, Text } from 'react-native';
import { Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { e164, isE164 } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Profile { businessName: string; storefront: { description: string | null; whatsappNumber: string | null; contactPhone: string | null } | null }
interface Prefs { enabled: boolean }

/** Store profile (what customers see) and whether LiveSell messages customers automatically. */
export default function StoreSettings() {
  useTheme();
  const { can } = useAuth();
  const profile = useApi<Profile>('/store/profile');
  const prefs = useApi<Prefs & Record<string, unknown>>(can('store:manage') ? '/notifications/preferences' : null);
  const [f, setF] = useState({ businessName: '', description: '', whatsappNumber: '', contactPhone: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    const p = profile.data;
    if (p) setF({ businessName: p.businessName, description: p.storefront?.description ?? '', whatsappNumber: p.storefront?.whatsappNumber ?? '', contactPhone: p.storefront?.contactPhone ?? '' });
  }, [profile.data]);

  if (!can('store:manage')) return <Screen><Notice tone="warn">Only the owner or a manager can change store settings.</Notice></Screen>;
  if (profile.error) return <Screen><ErrorBox message={profile.error} onRetry={profile.reload} /></Screen>;
  if (!profile.data) return <Loading />;
  const wa = f.whatsappNumber ? e164(f.whatsappNumber) : '';
  const ph = f.contactPhone ? e164(f.contactPhone) : '';
  const valid = f.businessName.trim().length >= 2 && (!wa || isE164(wa)) && (!ph || isE164(ph));

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card style={{ gap: 10 }}>
        <Field label="Business name" value={f.businessName} onChangeText={(v) => setF({ ...f, businessName: v })} />
        <Field label="About your store" value={f.description} onChangeText={(v) => setF({ ...f, description: v })} multiline style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 10 }} />
        <Field label="WhatsApp number" value={f.whatsappNumber} onChangeText={(v) => setF({ ...f, whatsappNumber: v })} keyboardType="phone-pad" error={wa && !isE164(wa) ? 'Enter a valid number' : null} />
        <Field label="Contact phone" value={f.contactPhone} onChangeText={(v) => setF({ ...f, contactPhone: v })} keyboardType="phone-pad" error={ph && !isE164(ph) ? 'Enter a valid number' : null} />
        <Button title="Save" disabled={!valid} loading={busy === 'profile'} onPress={() => void run('profile', async () => {
          await api('/store/profile', { method: 'PATCH', body: { businessName: f.businessName.trim(), description: f.description.trim(), ...(wa ? { whatsappNumber: wa } : {}), ...(ph ? { contactPhone: ph } : {}) } });
          await profile.reload();
        }, 'Store details saved.')} />
      </Card>
      {prefs.data ? (
        <Card style={{ gap: 6 }}>
          <Row><Text style={{ color: c.ink, flex: 1 }}>Message customers automatically</Text>
            <Switch value={prefs.data.enabled} disabled={busy === 'prefs'} onValueChange={(v) => void run('prefs', async () => prefs.setData(await api<Prefs & Record<string, unknown>>('/notifications/preferences', { method: 'PUT', body: { ...prefs.data, enabled: v } })), v ? 'Automatic messages on.' : 'Automatic messages off.')} /></Row>
          <Muted>Order, payment and delivery updates by WhatsApp, SMS and email. Choose per message on the web.</Muted>
        </Card>
      ) : null}
    </Screen>
  );
}
