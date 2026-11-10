import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Hero3D } from '@/components/hero';
import { Button, Card, Field, H1, Muted, Notice, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import * as bio from '@/lib/biometric';
import { useTheme } from '@/lib/theme';

const isEmail = (v: string) => /^\S+@\S+\.\S+$/.test(v);
const isPhone = (v: string) => /^\+?[\d\s()-]{8,18}$/.test(v) && v.replace(/\D/g, '').length >= 8;

export default function Login() {
  useTheme();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = identifier.trim();
  const valid = (isEmail(id) || isPhone(id)) && password.length >= 8;

  useEffect(() => {
    void bio.rememberedIdentifier().then((v) => { if (v) setIdentifier(v); });
  }, []);

  async function offerBiometrics() {
    const s = await bio.support();
    if (!s.available || (await bio.wasAsked())) return;
    Alert.alert(`Sign in with ${s.label}?`, `Next time, open LiveSell with your ${s.label} instead of typing your password.`, [
      { text: 'Not now', style: 'cancel', onPress: () => void bio.setEnabled(false) },
      { text: 'Turn on', onPress: () => void bio.authenticate(`Confirm your ${s.label}`).then((ok) => bio.setEnabled(ok)) },
    ]);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(isEmail(id) ? id.toLowerCase() : id, password, remember);
      void offerBiometrics();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.canvas }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, gap: 18, width: '100%', maxWidth: 460, alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', gap: 6 }}>
            <Hero3D size={96} />
            <Text style={{ color: c.brand, fontWeight: '800', fontSize: 16, letterSpacing: 0.5 }}>LIVESELL AFRICA</Text>
            <H1>Welcome back</H1>
            <Muted>Sign in with your email or phone number.</Muted>
          </View>
          <Card style={{ gap: 14 }}>
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <Field label="Email or phone number" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false}
              autoComplete="username" textContentType="username" keyboardType={/^[+\d]/.test(id) ? 'phone-pad' : 'email-address'} placeholder="ada@shop.ng or 0803 123 4567"
              error={id.length > 3 && !isEmail(id) && !isPhone(id) ? 'Enter an email address or a phone number' : null} />
            <Field label="Password" password value={password} onChangeText={setPassword} autoComplete="password" textContentType="password"
              returnKeyType="go" onSubmitEditing={() => valid && void submit()} />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: c.ink2 }}>Remember my email or phone</Text>
              <Switch value={remember} onValueChange={setRemember} trackColor={{ true: c.brand, false: c.line }} thumbColor={c.surface} accessibilityLabel="Remember my email or phone" />
            </View>
            <Button title="Sign in" onPress={() => void submit()} loading={busy} disabled={!valid} />
          </Card>
          <Button variant="secondary" title="Create a new store" onPress={() => router.push('/signup')} />
          <Muted>Your password is never saved on this phone. After signing in you can turn on fingerprint or face unlock.</Muted>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
