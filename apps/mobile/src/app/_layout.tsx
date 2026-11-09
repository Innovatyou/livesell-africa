import * as Notifications from 'expo-notifications';
import { Redirect, router, Stack, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading, c } from '@/components/ui';
import { AuthProvider, useAuth } from '@/lib/auth';
import { flush } from '@/lib/offline-queue';
import { routeFor } from '@/lib/push';

function Gate() {
  const { status, workspace, selectTenant } = useAuth();
  const segments = useSegments();
  const lastTap = Notifications.useLastNotificationResponse();

  // A tapped notification opens its order — in the right store.
  useEffect(() => {
    if (status !== 'signedIn' || !lastTap) return;
    const target = routeFor(lastTap.notification.request.content.data as Record<string, unknown>);
    void Notifications.clearLastNotificationResponseAsync();
    if (!target) return;
    void (async () => {
      if (workspace?.id !== target.tenantId) await selectTenant(target.tenantId).catch(() => undefined);
      router.push(target.path as never);
    })();
  }, [lastTap, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Orders saved offline go out when the app comes back to the foreground (and on sign-in / store switch).
  useEffect(() => {
    if (status !== 'signedIn' || !workspace) return;
    void flush(workspace.id);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void flush(workspace.id); });
    return () => sub.remove();
  }, [status, workspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading') return <Loading />;
  const onLogin = segments[0] === 'login' || segments[0] === 'signup';
  if (status === 'signedOut' && !onLogin) return <Redirect href="/login" />;
  if (status === 'signedIn' && onLogin) return <Redirect href="/" />;
  return (
    <Stack screenOptions={{ headerTintColor: c.brand, headerTitleStyle: { color: c.ink }, contentStyle: { backgroundColor: c.canvas } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="signup" options={{ title: 'Create your store' }} />
      <Stack.Screen name="products/[id]" options={{ title: 'Product' }} />
      <Stack.Screen name="settings/store" options={{ title: 'Store settings' }} />
      <Stack.Screen name="settings/delivery" options={{ title: 'Delivery' }} />
      <Stack.Screen name="analytics" options={{ title: 'Analytics' }} />
      <Stack.Screen name="billing" options={{ title: 'Plan & billing' }} />
      <Stack.Screen name="orders/[id]" options={{ title: 'Order' }} />
      <Stack.Screen name="live/[id]" options={{ title: 'Live session' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AuthProvider><Gate /></AuthProvider>
    </SafeAreaProvider>
  );
}
