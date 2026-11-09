import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, ApiError } from './api';

/**
 * Orders recorded during a live while the connection drops. Each one gets a `clientRef` the moment it is saved, so
 * sending it again (after a timeout, an app restart, or twice by accident) can never create a second order: the API
 * returns the order it already made. Only network failures and server errors stay queued; anything the server
 * refused (sold out, bad code) is kept with its reason for the seller to fix or discard.
 * Stored on the device only (AsyncStorage) — order details, never tokens.
 */
const KEY = 'ls.offline-orders';

export interface QueuedOrder {
  clientRef: string;
  tenantId: string;
  body: Record<string, unknown>;
  label: string; // "2 × BAG001 · Amaka"
  createdAt: string;
  attempts: number;
  failed?: string; // server refused it: needs the seller
}

export const newClientRef = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function list(): Promise<QueuedOrder[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedOrder[]) : [];
  } catch {
    return [];
  }
}

async function save(items: QueuedOrder[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}

export async function enqueue(tenantId: string, body: Record<string, unknown>, label: string): Promise<QueuedOrder> {
  const item: QueuedOrder = { clientRef: String(body.clientRef ?? newClientRef()), tenantId, body: { ...body }, label, createdAt: new Date().toISOString(), attempts: 0 };
  item.body.clientRef = item.clientRef;
  const items = await list();
  if (!items.some((i) => i.clientRef === item.clientRef)) await save([...items, item]);
  return item;
}

export async function discard(clientRef: string) {
  await save((await list()).filter((i) => i.clientRef !== clientRef));
}

/** Network or server trouble: worth trying again later. */
export const retryable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);

let flushing: Promise<{ sent: number; failed: number; left: number }> | null = null;

/** Send what's queued for this store (oldest first). Safe to call often; one flush runs at a time. */
export function flush(tenantId: string | null): Promise<{ sent: number; failed: number; left: number }> {
  flushing ??= (async () => {
    let sent = 0;
    let failed = 0;
    try {
      for (const item of await list()) {
        if (item.tenantId !== tenantId || item.failed) continue;
        try {
          await api('/orders', { method: 'POST', body: item.body });
          await discard(item.clientRef);
          sent++;
        } catch (e) {
          const items = await list();
          const i = items.find((x) => x.clientRef === item.clientRef);
          if (!i) continue;
          i.attempts++;
          if (!retryable(e)) {
            i.failed = (e as Error).message;
            failed++;
          }
          await save(items);
          if (retryable(e)) break; // still offline: stop for now, keep the order
        }
      }
      return { sent, failed, left: (await list()).filter((i) => i.tenantId === tenantId).length };
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
