import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { MessagingRejectedError } from '../src/messaging/messaging-provider';
import { VeltrixMessagingAdapter } from '../src/messaging/veltrix.adapter';

/**
 * The real Veltrix adapter against a running Veltrix install (rule 6). Never sends a real message: it reads the
 * account and wallet, and sends WhatsApp through a server that does not exist (refused before anything is sent).
 * Skipped unless TEST_VELTRIX_BASE_URL and TEST_VELTRIX_API_KEY are set, e.g. the local install:
 *   TEST_VELTRIX_BASE_URL=http://mailwizz-yii3.test TEST_VELTRIX_API_KEY=<temporary key> npm run test:e2e -- veltrix-local
 */
const base = process.env.TEST_VELTRIX_BASE_URL;
const key = process.env.TEST_VELTRIX_API_KEY;
const run = base && key ? describe : describe.skip;

run('Veltrix (real API, no messages sent)', () => {
  const env: Record<string, unknown> = {
    VELTRIX_ENABLED: true, VELTRIX_BASE_URL: base, VELTRIX_API_KEY: key, VELTRIX_SMS_SENDER: 'LIVESELL', VELTRIX_EMAIL_FROM: 'test@livesell.africa',
    VELTRIX_EMAIL_FROM_NAME: 'LiveSell', VELTRIX_WHATSAPP_SERVER_UID: `none${randomBytes(4).toString('hex')}`,
  };
  const a = new VeltrixMessagingAdapter({ get: (k: string) => env[k] } as unknown as ConfigService<never, true>);
  jest.setTimeout(30_000);

  it('authenticates and reads the account and wallet', async () => {
    const s = await a.status();
    expect(s.error).toBeUndefined();
    expect(s.configured).toBe(true);
    expect(s.account?.email).toMatch(/@/);
    expect(s.wallet?.balance).toMatch(/^-?\d+(\.\d+)?$/);
    expect(JSON.stringify(s)).not.toContain(key!);
  });

  it('a refused send is permanent, and the same idempotency key replays the first answer', async () => {
    const k = `ls-local-${randomBytes(6).toString('hex')}`;
    const e1 = await a.sendWhatsapp({ to: '+2348000000000', text: 'never sent', idempotencyKey: k }).catch((e) => e);
    expect(e1).toBeInstanceOf(MessagingRejectedError);
    expect(e1.code).toBe('NOT_FOUND');
    const e2 = await a.sendWhatsapp({ to: '+2348000000000', text: 'never sent', idempotencyKey: k }).catch((e) => e);
    expect(e2).toMatchObject({ code: 'NOT_FOUND', message: e1.message });
    const e3 = await a.sendWhatsapp({ to: '+2348000000000', text: 'a different body', idempotencyKey: k }).catch((e) => e);
    expect(e3).toMatchObject({ code: 'REJECTED' }); // 422: same key, different request
  });

  it('looks up an SMS delivery receipt by message id (unknown → UNKNOWN), or reports SMS as off', async () => {
    const r = await a.smsDelivery(`no-such-${randomBytes(4).toString('hex')}`).catch((e) => e);
    if (r instanceof MessagingRejectedError) expect(r.code).toBe('CHANNEL_DISABLED');
    else expect(r).toBe('UNKNOWN');
  });

  it('a wrong key is refused', async () => {
    const bad = new VeltrixMessagingAdapter({ get: (k: string) => ({ ...env, VELTRIX_API_KEY: 'wrong-key-0000000000' })[k] } as unknown as ConfigService<never, true>);
    const s = await bad.status();
    expect(s.error).toMatch(/API key/);
  });
});
