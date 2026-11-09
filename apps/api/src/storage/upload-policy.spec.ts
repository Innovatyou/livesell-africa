import { assertUploadAllowed, buildKey, keyBelongsTo, sniffContentType, UploadPolicyError } from './upload-policy';

const T = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

describe('upload policy', () => {
  it('allows only raster images for logos (no SVG) up to 2 MB', () => {
    expect(() => assertUploadAllowed('logo', 'image/png', 1000)).not.toThrow();
    expect(() => assertUploadAllowed('logo', 'image/svg+xml', 1000)).toThrow(UploadPolicyError);
    expect(() => assertUploadAllowed('logo', 'application/pdf', 1000)).toThrow(UploadPolicyError);
    expect(() => assertUploadAllowed('logo', 'image/png', 2 * 1024 * 1024 + 1)).toThrow(/too large/);
    expect(() => assertUploadAllowed('logo', 'image/png', 0)).toThrow(/empty/);
    expect(() => assertUploadAllowed('verification-document', 'application/pdf', 5 * 1024 * 1024)).not.toThrow();
    expect(() => assertUploadAllowed('product-image', 'video/mp4', 1000)).toThrow(UploadPolicyError);
    expect(() => assertUploadAllowed('product-video', 'video/mp4', 50 * 1024 * 1024)).not.toThrow();
    expect(() => assertUploadAllowed('product-video', 'video/quicktime', 1000)).toThrow(UploadPolicyError);
  });

  it('builds tenant-prefixed keys and only accepts keys of the same tenant and purpose', () => {
    const logo = buildKey(T, 'logo', 'image/webp', ID);
    expect(logo).toBe(`tenants/${T}/logos/${ID}.webp`);
    expect(keyBelongsTo(logo, T, 'logo')).toBe(true);
    expect(keyBelongsTo(logo, OTHER, 'logo')).toBe(false);
    expect(keyBelongsTo(logo, T, 'verification-document')).toBe(false);
    expect(keyBelongsTo(`tenants/${T}/logos/../../${OTHER}/logos/${ID}.png`, T, 'logo')).toBe(false);
    expect(keyBelongsTo(`tenants/${T}/logos/${ID}.svg`, T, 'logo')).toBe(false);
    const doc = buildKey(T, 'verification-document', 'application/pdf', ID);
    expect(doc).toBe(`tenants/${T}/private/verification/${ID}.pdf`);
    expect(keyBelongsTo(doc, T, 'verification-document')).toBe(true);
  });

  it('identifies files by magic bytes, not by the declared type', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    const pdf = new TextEncoder().encode('%PDF-1.7');
    const html = new TextEncoder().encode('<html><script>');
    expect(sniffContentType(png)).toBe('image/png');
    expect(sniffContentType(jpg)).toBe('image/jpeg');
    expect(sniffContentType(webp)).toBe('image/webp');
    expect(sniffContentType(pdf)).toBe('application/pdf');
    expect(sniffContentType(html)).toBeNull();
    expect(sniffContentType(new Uint8Array())).toBeNull();
    expect(sniffContentType(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('video/mp4');
    expect(sniffContentType(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe('video/webm');
  });
});
