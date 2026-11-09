import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

/**
 * Push notifications port (CLAUDE.md rule 5: providers behind ports). The adapter is the Expo push service, which
 * forwards to FCM (Android) and APNs (iOS) with the credentials uploaded to EAS — the API holds no FCM/APNs secrets.
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */
export interface PushMessage { to: string; title: string; body: string; data?: Record<string, string>; channelId?: string; priority?: 'default' | 'normal' | 'high' }
export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; message: string; error?: string };
export type PushReceipt = { status: 'ok' } | { status: 'error'; message?: string; error?: string };

export abstract class PushProvider {
  abstract readonly enabled: boolean;
  /** One ticket per message, in order. Throws on a whole-request failure (network, 5xx). */
  abstract send(messages: PushMessage[]): Promise<PushTicket[]>;
  abstract receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

@Injectable()
export class ExpoPushAdapter extends PushProvider {
  private readonly logger = new Logger('ExpoPush');
  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get enabled() {
    return this.config.get('PUSH_ENABLED', { infer: true });
  }

  private headers() {
    const token = this.config.get('EXPO_ACCESS_TOKEN', { infer: true });
    // Only needed when "enhanced push security" is switched on in the Expo dashboard.
    return { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const out: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += 100) { // max 100 per request
      const res = await fetch(SEND_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify(messages.slice(i, i + 100)), signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ status: string; id?: string; message?: string; details?: { error?: string } }>; errors?: unknown };
      if (!res.ok || !Array.isArray(body.data)) {
        this.logger.warn(`Expo push send failed: HTTP ${res.status}`);
        throw new Error(`Expo push send failed (HTTP ${res.status})`);
      }
      for (const t of body.data) out.push(t.status === 'ok' && t.id ? { status: 'ok', id: t.id } : { status: 'error', message: t.message ?? 'error', error: t.details?.error });
    }
    return out;
  }

  async receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (let i = 0; i < ticketIds.length; i += 1000) { // max 1000 ids per request
      const res = await fetch(RECEIPTS_URL, { method: 'POST', headers: this.headers(), body: JSON.stringify({ ids: ticketIds.slice(i, i + 1000) }), signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => ({}))) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> };
      if (!res.ok || !body.data) throw new Error(`Expo push receipts failed (HTTP ${res.status})`);
      for (const [id, r] of Object.entries(body.data)) out[id] = r.status === 'ok' ? { status: 'ok' } : { status: 'error', message: r.message, error: r.details?.error };
    }
    return out;
  }
}
