import { ApiError, api } from './api';
import type { PresignedUpload } from './types';

/**
 * Direct-to-storage upload: ask the API for a presigned PUT (type + exact size are signed), send the file
 * straight to S3/R2/MinIO, and return the key for the confirm call. The file never passes through the API.
 */
export async function uploadFile(presignPath: string, file: File, allowed: string[], maxBytes: number): Promise<string> {
  if (!allowed.includes(file.type)) throw new ApiError(400, `Unsupported file type. Use ${allowed.map((t) => t.split('/')[1].toUpperCase()).join(', ')}.`);
  if (file.size > maxBytes) throw new ApiError(400, `File is too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB).`);
  if (file.size === 0) throw new ApiError(400, 'File is empty.');
  const p = await api<PresignedUpload>(presignPath, { method: 'POST', body: { contentType: file.type, contentLength: file.size } });
  let res: Response;
  try {
    res = await fetch(p.uploadUrl, { method: 'PUT', body: file, headers: p.headers });
  } catch {
    throw new ApiError(0, "Upload failed. Check your connection and try again.");
  }
  if (!res.ok) throw new ApiError(res.status, 'Upload was rejected by storage. Please try again.');
  return p.key;
}
