// Test-only configuration. Secrets here are throwaway values for an isolated test database.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://livesell:livesell@localhost:5432/livesell_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-0123456789';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.TOKEN_HASH_SECRET = 'test-token-pepper-0123456789-0123456789';
process.env.AUTH_THROTTLE_LIMIT = '1000';
process.env.THROTTLE_LIMIT = '10000';
process.env.SALES_INQUIRY_LIMIT = '1000';
process.env.CHECKOUT_LIMIT = '1000';
process.env.PAYMENT_VERIFY_LIMIT = '10000';
process.env.JOBS_ENABLED = 'false';
// MinIO from docker-compose (test bucket). Override with TEST_S3_* to point at another S3-compatible store,
// either in the environment or in test/.env.s3 (gitignored; see test/.env.s3.example).
require('dotenv').config({ path: require('node:path').join(__dirname, '.env.s3'), quiet: true });
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://localhost:9000';
process.env.S3_REGION = process.env.TEST_S3_REGION || 'us-east-1';
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET || 'livesell-media-test';
process.env.S3_ACCESS_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID || 'livesell';
process.env.S3_SECRET_ACCESS_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY || 'livesell-minio-dev';
process.env.S3_FORCE_PATH_STYLE = process.env.TEST_S3_FORCE_PATH_STYLE || 'true';
process.env.S3_PUBLIC_BASE_URL = '';
// Payments: e2e suites use a fake provider (test/support.ts), never the real Paystack API. The platform key below
// is a throwaway placeholder so the real key in apps/api/.env is never picked up by the app under test.
process.env.PAYSTACK_SECRET_KEY = 'sk_test_e2eplatformplaceholder';
process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_e2eplatformplaceholder';
process.env.PAYSTACK_WEBHOOKS_ENABLED = 'true';
process.env.APP_URL = 'http://localhost:3000';
process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK' + '_TEST-e2eplatformplaceholder000000-X';
process.env.FLUTTERWAVE_PUBLIC_KEY = 'FLWPUBK_TEST-e2eplatformplaceholder000000-X';
process.env.FLUTTERWAVE_WEBHOOK_HASH = 'e2e-platform-flutterwave-hash';
process.env.FLUTTERWAVE_WEBHOOKS_ENABLED = 'true';
process.env.BACHS_API_KEY = 'sk_sandbox_e2e_platformplaceholder0000';
process.env.BACHS_WEBHOOK_SECRET = 'e2e-platform-bachs-signing-secret';
process.env.BACHS_WEBHOOKS_ENABLED = 'true';
// Messaging: the app under test never talks to a real Veltrix (suites override the providers with fakes).
process.env.VELTRIX_ENABLED = 'false';
process.env.VELTRIX_BASE_URL = '';
process.env.VELTRIX_API_KEY = '';
