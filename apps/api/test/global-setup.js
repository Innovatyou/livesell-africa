// Rebuilds the test database from the committed migrations, then seeds reference data.
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execSync } = require('node:child_process');
const { Client } = require('pg');

module.exports = async () => {
  require('./env');
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace('?schema=public', '') });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) {
    await db.query(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  }
  await db.end();
  execSync('npx ts-node prisma/seed.ts', { cwd: join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  await ensureTestBucket();
};

/** Creates the S3 test bucket if missing (docker-compose's minio-init normally does this). */
async function ensureTestBucket() {
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  });
  const Bucket = process.env.S3_BUCKET;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch (e) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      // Storage tests will fail with a clear message; the rest of the suite still runs.
      console.warn(`\n[e2e] Object storage not reachable at ${process.env.S3_ENDPOINT} (${err.name || err.message}). ` +
        'Start MinIO: docker compose up -d minio minio-init\n');
    }
  } finally {
    s3.destroy();
  }
}
