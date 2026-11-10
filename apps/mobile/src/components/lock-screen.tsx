import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Hero3D } from '@/components/hero';
import { Button, H1, Muted, Notice, c } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import * as bio from '@/lib/biometric';
import { useTheme } from '@/lib/theme';

/** Shown instead of the app while a saved session waits for fingerprint / face unlock. */
export function LockScreen() {
  useTheme();
  const { unlock, logout } = useAuth();
  const [label, setLabel] = useState('fingerprint');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function tryUnlock() {
    setBusy(true);
    const ok = await unlock();
    setBusy(false);
    setFailed(!ok);
  }

  useEffect(() => {
    void bio.support().then((s) => setLabel(s.label));
    void tryUnlock(); // prompt straight away
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 14, width: '100%', maxWidth: 460, alignSelf: 'center' }}>
        <Hero3D size={88} />
        <H1>LiveSell is locked</H1>
        <Muted>Use your {label} to continue.</Muted>
        {failed ? <Notice tone="warn">Not recognised. Try again, or sign in with your password.</Notice> : null}
        <View style={{ alignSelf: 'stretch', gap: 10 }}>
          <Button title={`Unlock with ${label}`} onPress={() => void tryUnlock()} loading={busy} />
          <Button variant="secondary" title="Sign in with password" onPress={() => void logout()} />
        </View>
        <Text style={{ color: c.ink3, fontSize: 12, textAlign: 'center' }}>Signing in with your password ends this session on this phone.</Text>
      </View>
    </SafeAreaView>
  );
}
