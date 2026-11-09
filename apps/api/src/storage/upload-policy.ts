/**
 * What may be uploaded, where it goes, and how its bytes are checked. Pure functions: unit-tested without S3.
 *
 * Keys always start with `tenants/<tenantId>/`. Public media (logos) and private documents live under
 * different sub-prefixes so a CDN / bucket policy can expose one without the other.
 */
export type UploadPurpose = 'logo' | 'cover' | 'product-image' | 'product-video' | 'verification-document' | 'transfer-receipt';

interface PurposePolicy {
  prefix: string;
  maxBytes: number;
  visibility: 'public' | 'private';
  types: Record<string, string>; // content type -> file extension
}

export const UPLOAD_POLICIES: Record<UploadPurpose, PurposePolicy> = {
  // SVG is deliberately excluded: it can carry script.
  logo: {
    prefix: 'logos',
    maxBytes: 2 * 1024 * 1024,
    visibility: 'public',
    types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
  },
  cover: {
    prefix: 'covers',
    maxBytes: 3 * 1024 * 1024,
    visibility: 'public',
    types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
  },
  'product-image': {
    prefix: 'products',
    maxBytes: 5 * 1024 * 1024,
    visibility: 'public',
    types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
  },
  'product-video': {
    prefix: 'products',
    maxBytes: 50 * 1024 * 1024,
    visibility: 'public',
    types: { 'video/mp4': 'mp4', 'video/webm': 'webm' },
  },
  'verification-document': {
    prefix: 'private/verification',
    maxBytes: 5 * 1024 * 1024,
    visibility: 'private',
    types: { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' },
  },
  // A customer's bank-transfer receipt (screenshot or PDF). Evidence for a person to check, never proof of payment.
  'transfer-receipt': {
    prefix: 'private/transfers',
    maxBytes: 5 * 1024 * 1024,
    visibility: 'private',
    types: { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
  },
};

export class UploadPolicyError extends Error {}

export function assertUploadAllowed(purpose: UploadPurpose, contentType: string, contentLength: number) {
  const policy = UPLOAD_POLICIES[purpose];
  if (!policy.types[contentType]) {
    throw new UploadPolicyError(`File type not allowed. Use ${Object.keys(policy.types).join(', ')}`);
  }
  if (!Number.isInteger(contentLength) || contentLength < 1) throw new UploadPolicyError('File is empty');
  if (contentLength > policy.maxBytes) {
    throw new UploadPolicyError(`File is too large (max ${Math.floor(policy.maxBytes / 1024 / 1024)} MB)`);
  }
  return policy;
}

export function buildKey(tenantId: string, purpose: UploadPurpose, contentType: string, id: string) {
  const policy = UPLOAD_POLICIES[purpose];
  return `tenants/${tenantId}/${policy.prefix}/${id}.${policy.types[contentType]}`;
}

/** True only for keys this tenant could have been issued for this purpose (no traversal, no other tenant). */
export function keyBelongsTo(key: string, tenantId: string, purpose: UploadPurpose) {
  const policy = UPLOAD_POLICIES[purpose];
  const exts = Object.values(policy.types).join('|');
  const re = new RegExp(`^tenants/${tenantId}/${policy.prefix.replace('/', '\\/')}/[0-9a-f-]{36}\\.(${exts})$`);
  return re.test(key);
}

/** Identifies the real file type from its first bytes. The declared content type must match it. */
export function sniffContentType(head: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => head[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4'; // ISO BMFF: ....ftyp
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'; // EBML
  return null;
}
