import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Env } from '../config/env';
import { REDIS } from '../redis/redis.module';
import {
  assertUploadAllowed, buildKey, keyBelongsTo, sniffContentType, UPLOAD_POLICIES, UploadPolicyError, UploadPurpose,
} from './upload-policy';

const PUT_TTL_SECONDS = 300;
const GET_TTL_SECONDS = 3600;
const PENDING_TTL_SECONDS = 900;

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  method: 'PUT';
  /** Headers the client must send exactly; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

interface PendingUpload { tenantId: string; purpose: UploadPurpose; contentType: string; contentLength: number }

/**
 * S3-API object storage (MinIO / Cloudflare R2 / AWS S3 — configured only by S3_* env vars).
 * Upload flow: presign PUT (type + exact size signed, 5-minute expiry) → client uploads directly →
 * server confirms: key was issued to this tenant, object exists (HEAD), size and type match, magic bytes match.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBase?: string;

  constructor(config: ConfigService<Env, true>, @Inject(REDIS) private readonly redis: Redis) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.publicBase = config.get('S3_PUBLIC_BASE_URL', { infer: true })?.replace(/\/+$/, '');
    this.s3 = new S3Client({
      region: config.get('S3_REGION', { infer: true }),
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      },
      // Only send checksums when an operation requires them: keeps presigned URLs portable across MinIO/R2/S3.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignUpload(tenantId: string, purpose: UploadPurpose, contentType: string, contentLength: number): Promise<PresignedUpload> {
    let policy;
    try {
      policy = assertUploadAllowed(purpose, contentType, contentLength);
    } catch (e) {
      if (e instanceof UploadPolicyError) throw new BadRequestException(e.message);
      throw e;
    }
    const key = buildKey(tenantId, purpose, contentType, randomUUID());
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: PUT_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    const pending: PendingUpload = { tenantId, purpose, contentType, contentLength };
    await this.redis.set(this.pendingKey(key), JSON.stringify(pending), 'EX', PENDING_TTL_SECONDS);
    return {
      key, uploadUrl, method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + PUT_TTL_SECONDS * 1000).toISOString(),
      maxBytes: policy.maxBytes,
    };
  }

  /**
   * Confirms an uploaded object before its key is saved anywhere. Invalid objects are deleted.
   * Single use: the pending record is consumed, so a key cannot be confirmed twice or by another tenant.
   */
  async confirmUpload(tenantId: string, purpose: UploadPurpose, key: string): Promise<{ key: string; size: number; contentType: string }> {
    const fail = (msg: string) => new BadRequestException(msg);
    if (!keyBelongsTo(key, tenantId, purpose)) throw fail('Unknown upload');

    const [[, raw]] = (await this.redis.multi().get(this.pendingKey(key)).del(this.pendingKey(key)).exec()) as [[Error | null, string | null]];
    if (!raw) throw fail('Upload expired or already used; please upload the file again');
    const pending = JSON.parse(raw) as PendingUpload;
    if (pending.tenantId !== tenantId || pending.purpose !== purpose) throw fail('Unknown upload');

    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw fail('File not found; the upload may not have finished');
    }
    const size = Number(head.ContentLength ?? 0);
    const policy = UPLOAD_POLICIES[purpose];
    const actualType = sniffContentType(await this.readHead(key));
    const valid =
      size > 0 && size <= policy.maxBytes && size === pending.contentLength &&
      head.ContentType === pending.contentType && actualType === pending.contentType;
    if (!valid) {
      await this.delete(key);
      throw fail('The uploaded file is not a valid ' + Object.keys(policy.types).join(' / ') + ' file');
    }
    return { key, size, contentType: pending.contentType };
  }

  /** URL a browser can load. Public media uses the CDN/public base when configured; everything else is presigned. */
  async readUrl(key: string, purpose: UploadPurpose): Promise<string> {
    if (UPLOAD_POLICIES[purpose].visibility === 'public' && this.publicBase) return `${this.publicBase}/${key}`;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: GET_TTL_SECONDS });
  }

  async delete(key: string) {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      this.logger.warn(`Could not delete object ${key}: ${(e as Error).message}`);
    }
  }

  private async readHead(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-15' }));
    return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
  }

  private pendingKey(key: string) {
    return `upload:pending:${key}`;
  }
}
