import { productionProblems } from './production-checks';
import { z } from 'zod';

/** All configuration is validated at boot. The process refuses to start with missing or weak secrets. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().default(30),

  /** 32-byte key, base64. Encrypts gateway credentials, bank account numbers, MFA secrets. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes base64'),

  /** Hash pepper for verification / refresh tokens (HMAC-SHA256). */
  TOKEN_HASH_SECRET: z.string().min(32),

  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  THROTTLE_TTL_MS: z.coerce.number().int().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().default(120),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().default(10),

  /** S3 API (MinIO in dev/test, Cloudflare R2 or AWS S3 in production). Empty endpoint = AWS S3. */
  S3_ENDPOINT: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Public base URL for public media (logos). Empty => short-lived presigned GET URLs are returned instead. */
  S3_PUBLIC_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  /** Background jobs (BullMQ). Disabled in tests, which drive the job services directly. */
  /** Public base URL of this API (webhook URLs shown to sellers). */
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  /** Platform Paystack account: subscription billing and split-settlement order payments. Empty = not configured. */
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/).optional().or(z.literal('').transform(() => undefined)),
  PAYSTACK_PUBLIC_KEY: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/).optional().or(z.literal('').transform(() => undefined)),
  /** Off until the webhook signature scheme is confirmed from Paystack's docs. Payments never depend on webhooks. */
  PAYSTACK_WEBHOOKS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Platform Flutterwave account (split settlement). Webhook hash = the "secret hash" set on the Flutterwave dashboard. */
  FLUTTERWAVE_SECRET_KEY: z.string().regex(/^FLWSECK(_TEST)?-[A-Za-z0-9]{16,}-X$/).optional().or(z.literal('').transform(() => undefined)),
  FLUTTERWAVE_PUBLIC_KEY: z.string().regex(/^FLWPUBK(_TEST)?-[A-Za-z0-9]{16,}-X$/).optional().or(z.literal('').transform(() => undefined)),
  /** Only used by Flutterwave's direct card-charge API, which LiveSell does not use (hosted checkout only). */
  FLUTTERWAVE_ENCRYPTION_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(16).optional().or(z.literal('').transform(() => undefined)),
  FLUTTERWAVE_WEBHOOKS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  /** Platform Bachs account. Webhook secret = the endpoint's signing secret from the Bachs Developer Portal. */
  BACHS_API_KEY: z.string().regex(/^sk_(sandbox|live)_[A-Za-z0-9_-]{16,}$/).optional().or(z.literal('').transform(() => undefined)),
  BACHS_WEBHOOK_SECRET: z.string().min(16).optional().or(z.literal('').transform(() => undefined)),
  BACHS_WEBHOOKS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  /** Veltrix (messaging + verification). Off until a platform account is configured; nothing is sent while off. */
  VELTRIX_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Site root, e.g. https://veltrix.ng — the client derives /api/v1 (messaging) and /api/verify/v1 (Verify). */
  VELTRIX_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Customer API key of LiveSell's platform Veltrix account (X-MW-PUBLIC-KEY). */
  VELTRIX_API_KEY: z.string().min(16).optional().or(z.literal('').transform(() => undefined)),
  /** Approved SMS sender ID on that account (e.g. LIVESELL). */
  VELTRIX_SMS_SENDER: z.string().regex(/^[A-Za-z0-9 ]{3,11}$/).optional().or(z.literal('').transform(() => undefined)),
  VELTRIX_EMAIL_FROM: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  VELTRIX_EMAIL_FROM_NAME: z.string().max(80).default('LiveSell Africa'),
  /** WhatsApp number (server_uid) LiveSell sends from; template sends need approved templates on it. */
  VELTRIX_WHATSAPP_SERVER_UID: z.string().max(64).optional().or(z.literal('').transform(() => undefined)),
  /** Veltrix Verify partner credential "<key_id>.<secret>" (Bearer). Empty = automated registry checks off. */
  VELTRIX_VERIFY_KEY: z.string().regex(/^[^.\s]+\.[^\s]+$/).optional().or(z.literal('').transform(() => undefined)),

  /** Optional incoming-webhook URL (Slack/Teams) for 5xx alerts, at most one per distinct error per 5 minutes. */
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  /** Seller push notifications through the Expo push service (credentials for FCM/APNs live in EAS, not here). */
  PUSH_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Only if "enhanced push security" is on in the Expo dashboard. */
  EXPO_ACCESS_TOKEN: z.string().min(10).optional().or(z.literal('').transform(() => undefined)),

  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const problems = productionProblems(parsed.data);
  if (problems.length) throw new Error(`Unsafe ${parsed.data.NODE_ENV} configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return parsed.data;
}
