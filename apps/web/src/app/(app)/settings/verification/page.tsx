'use client';

import { useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { uploadFile } from '@/lib/upload';
import { useApi } from '@/lib/use-api';

interface Status {
  verifiedAt: string | null;
  businessType: string;
  latest: null | { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; registeredName: string; registrationType: string; registrationNumber: string; rejectionReason: string | null; createdAt: string; reviewedAt: string | null };
}

const TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const MAX = 5 * 1024 * 1024;
const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));
const REG_TYPES: Array<[string, string]> = [['CAC_RC', 'Limited company (RC number)'], ['CAC_BN', 'Business name (BN number)'], ['OTHER', 'Other registration']];

export default function VerificationPage() {
  const { can, reload: reloadSession } = useAuth();
  const allowed = can('store:manage');
  const status = useApi<Status>(allowed ? '/business-verification' : null);
  const [registeredName, setName] = useState('');
  const [registrationType, setType] = useState('CAC_RC');
  const [registrationNumber, setNumber] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  if (!allowed) return <Card><EmptyState title="Only the owner can verify the business" /></Card>;
  if (status.error) return <ErrorState message={status.error} onRetry={status.reload} />;
  if (!status.data) return <PageLoading />;

  const s = status.data;
  const numberOk = /^[A-Za-z0-9-]{4,20}$/.test(registrationNumber.trim());
  const fileErr = file && (!TYPES.includes(file.type) ? 'Upload a PDF, PNG or JPG' : file.size > MAX ? 'File must be 5 MB or smaller' : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || fileErr) return;
    setBusy(true);
    setError(null);
    try {
      const documentKey = await uploadFile('/business-verification/upload-url', file, TYPES, MAX);
      await api('/business-verification', { method: 'POST', body: { registeredName: registeredName.trim(), registrationType, registrationNumber: registrationNumber.trim(), documentKey } });
      setDone(true);
      await status.reload();
      void reloadSession();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showForm = !s.verifiedAt && s.latest?.status !== 'PENDING';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Business verification" description="Optional. Verified businesses get a badge on their storefront." />
      {done && <Alert tone="good" title="Submitted for review">We&apos;ll review your documents and update this page. This usually takes 1–2 business days.</Alert>}

      {s.verifiedAt ? (
        <Card className="p-5"><Alert tone="good" title="Your business is verified">Verified on {date(s.verifiedAt)}.</Alert></Card>
      ) : s.latest?.status === 'PENDING' ? (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2">Request under review <Badge tone="info">Pending</Badge></span>} />
          <dl className="grid gap-3 p-5 text-sm sm:grid-cols-2">
            <div><dt className="text-ink-3">Registered name</dt><dd className="font-medium">{s.latest.registeredName}</dd></div>
            <div><dt className="text-ink-3">Registration number</dt><dd className="font-medium">{s.latest.registrationNumber}</dd></div>
            <div><dt className="text-ink-3">Submitted</dt><dd>{date(s.latest.createdAt)}</dd></div>
          </dl>
        </Card>
      ) : null}

      {showForm && (
        <Card>
          <CardHeader title="Submit your registration" description="Upload your CAC certificate. It is stored privately and only seen by LiveSell reviewers." />
          <form onSubmit={submit} className="space-y-4 p-5">
            {s.latest?.status === 'REJECTED' && (
              <Alert tone="bad" title="Your last request was not approved">{s.latest.rejectionReason ?? 'Please check your details and try again.'}</Alert>
            )}
            {s.businessType === 'INDIVIDUAL' && <Alert tone="info">You registered as an individual seller. Verification is meant for CAC-registered businesses.</Alert>}
            {error && <Alert tone="bad">{error}</Alert>}
            <Field label="Registered business name">{(p) => <Input {...p} value={registeredName} onChange={(e) => setName(e.target.value)} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Registration type">{(p) => <Select {...p} value={registrationType} onChange={(e) => setType(e.target.value)}>{REG_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
              <Field label="Registration number" error={registrationNumber && !numberOk ? '4–20 letters, numbers or hyphens' : null}>{(p) => <Input {...p} placeholder="RC1234567" value={registrationNumber} onChange={(e) => setNumber(e.target.value)} />}</Field>
            </div>
            <Field label="Certificate (PDF, PNG or JPG, up to 5 MB)" error={fileErr}>
              {(p) => (
                <div className="flex items-center gap-3">
                  <input {...p} ref={input} type="file" accept={TYPES.join(',')} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>{file ? 'Change file' : 'Choose file'}</Button>
                  <span className="truncate text-sm text-ink-3">{file ? file.name : 'No file chosen'}</span>
                </div>
              )}
            </Field>
            <Button type="submit" loading={busy} disabled={registeredName.trim().length < 2 || !numberOk || !file || !!fileErr}>Submit for review</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
