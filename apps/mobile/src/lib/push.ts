import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Push notifications on this phone (new customer orders, transfers to check). Docs: docs.expo.dev push setup, SDK 58.
 * Remote push needs a development or store build (not Expo Go on Android) and an EAS project id (`eas init`).
 */
const TOKEN_KEY = 'ls.push';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

export type PushState = { status: 'on'; token: string } | { status: 'off' } | { status: 'denied' } | { status: 'unavailable'; reason: string };

export const projectId = (): string | undefined =>
  (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;

/** Ask (if needed), get the Expo push token and register it with LiveSell. */
export async function enablePush(): Promise<PushState> {
  if (Platform.OS === 'android') {
    // Android 13+: the channel must exist before asking, or the prompt never appears.
    await Notifications.setNotificationChannelAsync('orders', { name: 'Orders and payments', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250], lightColor: '#0e7a4d' });
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return { status: 'denied' };
  const pid = projectId();
  if (!pid) return { status: 'unavailable', reason: 'This build has no EAS project id yet (run `eas init`).' };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: pid })).data;
    await api('/me/devices', { method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android', deviceName: Constants.deviceName ?? undefined }, tenant: false });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    return { status: 'on', token };
  } catch (e) {
    return { status: 'unavailable', reason: (e as Error).message };
  }
}

export async function disablePush() {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) await api('/me/devices', { method: 'DELETE', body: { token }, tenant: false }).catch(() => undefined);
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function pushState(): Promise<PushState> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return { status: 'off' };
  const perm = await Notifications.getPermissionsAsync();
  return perm.granted ? { status: 'on', token } : { status: 'denied' };
}

/** Where a tapped notification should open (pure, tested). */
export function routeFor(data: Record<string, unknown> | undefined): { tenantId: string; path: string } | null {
  const orderId = typeof data?.orderId === 'string' ? data.orderId : null;
  const tenantId = typeof data?.tenantId === 'string' ? data.tenantId : null;
  if (!orderId || !tenantId || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  return { tenantId, path: `/orders/${orderId}` };
}
