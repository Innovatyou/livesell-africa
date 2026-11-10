import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Redirect, router, Stack, ThemeProvider as NavThemeProvider, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LockScreen } from '@/components/lock-screen';
import { Loading, c } from '@/components/ui';
import { AuthProvider, useAuth } from '@/lib/auth';
import { flush } from '@/lib/offline-queue';
import { routeFor } from '@/lib/push';
import { ThemeProvider, useTheme } from '@/lib/theme';

function Gate() {
  const { dark } = useTheme();
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
  if (status === 'locked') return <LockScreen />;
  const onLogin = segments[0] === 'login' || segments[0] === 'signup';
  if (status === 'signedOut' && !onLogin) return <Redirect href="/login" />;
  if (status === 'signedIn' && onLogin) return <Redirect href="/" />;
  const base = dark ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, primary: c.brand, background: c.canvas, card: c.surface, text: c.ink, border: c.line, notification: c.bad } };
  return (
    <NavThemeProvider value={navTheme}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <Stack screenOptions={{ headerTintColor: c.brand, headerStyle: { backgroundColor: c.canvas }, headerShadowVisible: false, headerTitleStyle: { color: c.ink, fontWeight: '800' }, contentStyle: { backgroundColor: c.canvas } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="signup" options={{ title: 'Create your store' }} />
      <Stack.Screen name="products/[id]" options={{ title: 'Product' }} />
      <Stack.Screen name="settings/store" options={{ title: 'Store settings' }} />
      <Stack.Screen name="settings/delivery" options={{ title: 'Delivery' }} />
      <Stack.Screen name="analytics" options={{ title: 'Analytics' }} />
      <Stack.Screen name="billing" options={{ title: 'Plan & billing' }} />
      <Stack.Screen name="verification" options={{ title: 'Business verification' }} />
      <Stack.Screen name="orders/[id]" options={{ title: 'Order' }} />
      <Stack.Screen name="live/[id]" options={{ title: 'Live session' }} />
      <Stack.Screen name="live/new" options={{ title: 'New live session' }} />
      <Stack.Screen name="team" options={{ title: 'Team & roles' }} />
      <Stack.Screen name="settings/payments" options={{ title: 'Payments' }} />
      <Stack.Screen name="settings/messages" options={{ title: 'Customer messages' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="learn/index" options={{ title: 'LiveSell Academy' }} />
      <Stack.Screen name="learn/[id]" options={{ title: 'Lesson' }} />
    </Stack>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider><AuthProvider><Gate /></AuthProvider></ThemeProvider>
    </SafeAreaProvider>
  );
}
