import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field, H1, Muted, Notice, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= 8;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.canvas }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.brand, fontWeight: '800', fontSize: 18 }}>LiveSell Africa</Text>
          <H1>Sign in to your store</H1>
          <Muted>Use the same email and password as on the web.</Muted>
        </View>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={() => valid && void submit()} />
        <Button title="Sign in" onPress={() => void submit()} loading={busy} disabled={!valid} />
        <Button variant="secondary" title="Create a new store" onPress={() => router.push('/signup')} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
