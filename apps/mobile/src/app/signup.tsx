import { useState } from 'react';
import { Linking, Pressable, Switch, Text, View } from 'react-native';
import { Button, Card, Field, Muted, Notice, Screen, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { e164, isE164 } from '@/lib/format';
import { WEB_HOST, WEB_URL } from '@/lib/links';
import { useTheme } from '@/lib/theme';

const WEB = WEB_URL;
const CATEGORIES = ['Fashion', 'Beauty', 'Electronics', 'Food', 'Home', 'Other'];

/** Create a store from the phone — the same fields and rules as the web sign-up (the API validates everything). */
export default function Signup() {
  useTheme();
  const { signup } = useAuth();
  const [f, setF] = useState({ businessName: '', ownerFullName: '', email: '', phone: '', storeUsername: '', state: '', city: '', businessAddress: '', businessCategory: 'Fashion', password: '' });
  const [registered, setRegistered] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const tel = e164(f.phone);
  const slugOk = /^[a-z0-9][a-z0-9-]{2,39}$/.test(f.storeUsername);
  const valid = f.businessName.trim().length >= 2 && f.ownerFullName.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(f.email.trim()) && isE164(tel) && slugOk
    && f.state.trim().length >= 2 && f.city.trim().length >= 2 && f.businessAddress.trim().length >= 3 && f.password.length >= 10 && agree;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signup({
        ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])), email: f.email.trim().toLowerCase(), phone: tel, country: 'NG',
        password: f.password, businessType: registered ? 'REGISTERED_BUSINESS' : 'INDIVIDUAL', acceptTerms: true, acceptPrivacy: true,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Muted>Your free trial starts today. You can add products and take orders straight away.</Muted>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <Card style={{ gap: 10 }}>
        <Field label="Business name" value={f.businessName} onChangeText={set('businessName')} />
        <Field label="Store link name" value={f.storeUsername} onChangeText={(v) => set('storeUsername')(v.toLowerCase())} autoCapitalize="none" placeholder="ada-fashion"
          error={f.storeUsername && !slugOk ? '3–40 lowercase letters, numbers or hyphens' : null} />
        <Muted>{f.storeUsername ? `${WEB_HOST}/store/${f.storeUsername}` : 'Your store page address'}</Muted>
        <Text style={{ fontWeight: '600', color: c.ink2 }}>Category</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CATEGORIES.map((k) => (
            <Pressable key={k} onPress={() => set('businessCategory')(k)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: f.businessCategory === k ? c.brand : c.line, backgroundColor: f.businessCategory === k ? c.brandSoft : c.surface }}>
              <Text style={{ color: f.businessCategory === k ? c.brand : c.ink2 }}>{k}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: c.ink }}>Registered with CAC</Text><Switch value={registered} onValueChange={setRegistered} /></View>
        {registered ? <Muted>After sign-up, add your RC/BN number and certificate in More → Business verification.</Muted> : null}
      </Card>
      <Card style={{ gap: 10 }}>
        <Field label="Your full name" value={f.ownerFullName} onChangeText={set('ownerFullName')} autoComplete="name" />
        <Field label="Email" value={f.email} onChangeText={set('email')} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Field label="Phone" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" placeholder="0803 123 4567" error={f.phone && !isE164(tel) ? 'Enter a valid phone number' : null} />
        <Field label="State" value={f.state} onChangeText={set('state')} />
        <Field label="City" value={f.city} onChangeText={set('city')} />
        <Field label="Business address" value={f.businessAddress} onChangeText={set('businessAddress')} />
        <Field label="Password" value={f.password} onChangeText={set('password')} secureTextEntry autoComplete="new-password" error={f.password && f.password.length < 10 ? 'At least 10 characters' : null} />
      </Card>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Switch value={agree} onValueChange={setAgree} accessibilityLabel="Accept terms and privacy policy" />
        <Text style={{ flex: 1, color: c.ink2 }}>I accept the <Text style={{ color: c.brand }} onPress={() => void Linking.openURL(`${WEB}/terms`)}>Terms</Text> and the <Text style={{ color: c.brand }} onPress={() => void Linking.openURL(`${WEB}/privacy`)}>Privacy Policy</Text>.</Text>
      </View>
      <Button title="Create my store" onPress={() => void submit()} loading={busy} disabled={!valid} />
      <Muted>We’ll email you a link to confirm your address.</Muted>
    </Screen>
  );
}
