'use client';

import { useState } from 'react';
import { LogoUploader } from '@/components/logo-uploader';
import { PageHeader } from '@/components/page-header';
import { PhoneVerify } from '@/components/phone-verify';
import { Alert, Badge, Button, ButtonLink, Card, ErrorState, Skeleton, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Checklist, ChecklistItem, StoreProfile } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function OnboardingPage() {
  const { me, workspace, can, reload: reloadSession } = useAuth();
  const checklist = useApi<Checklist>('/onboarding');
  const profile = useApi<StoreProfile>('/store/profile');
  const [open, setOpen] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([checklist.reload(), profile.reload(), reloadSession()]);
  };

  if (checklist.error) return <ErrorState message={checklist.error} onRetry={checklist.reload} />;

  const data = checklist.data;
  const next = data?.items.find((i) => !i.done)?.key;
  const current = open ?? next ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Welcome${me ? `, ${me.fullName.split(' ')[0]}` : ''}`} description={`Let's get ${workspace?.businessName ?? 'your store'} ready to sell.`} />

      <Card className="p-5">
        {!data ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium text-ink">{data.completed} of {data.total} steps done</p>
              <p className="text-sm text-ink-3 tabular">{data.percent}%</p>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={data.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
              <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${data.percent}%` }} />
            </div>
            {data.requiredRemaining === 0 && (
              <Alert tone="good" className="mt-4" title="Your store is set up" action={<ButtonLink href="/dashboard" size="sm" variant="secondary">Go to dashboard</ButtonLink>}>
                Products, live sessions and payments switch on in your account as they launch.
              </Alert>
            )}
          </div>
        )}
      </Card>

      <ol className="mt-4 space-y-3">
        {!data
          ? [0, 1, 2, 3].map((i) => <li key={i}><Skeleton className="h-16 w-full rounded-[var(--radius-card)]" /></li>)
          : data.items.map((item) => (
            <li key={item.key}>
              <Card className={cx('overflow-hidden', current === item.key && !item.done && 'ring-1 ring-brand-200')}>
                <button
                  className="flex w-full items-start gap-4 p-4 text-left"
                  aria-expanded={current === item.key}
                  onClick={() => setOpen(current === item.key ? '' : item.key)}
                >
                  <StepMark done={item.done} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cx('font-medium', item.done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink')}>{item.title}</span>
                      {!item.required && <Badge>Optional</Badge>}
                      {item.status === 'PENDING' && <Badge tone="info">Under review</Badge>}
                      {item.status === 'REJECTED' && <Badge tone="bad">Needs attention</Badge>}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-3">{item.description}</span>
                  </span>
                  <svg aria-hidden viewBox="0 0 24 24" className={cx('mt-1 size-4 shrink-0 text-ink-3 transition-transform', current === item.key && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={2}><path d="m6 9 6 6 6-6" /></svg>
                </button>
                {current === item.key && (
                  <div className="border-t border-line bg-canvas/50 p-4">
                    <StepAction item={item} profile={profile.data} canStore={can('store:manage')} canStaff={can('staff:manage')} onDone={refresh} onProfile={(p) => profile.setData(p)} />
                  </div>
                )}
              </Card>
            </li>
          ))}
      </ol>
    </div>
  );
}

function StepMark({ done }: { done: boolean }) {
  return done ? (
    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-600 text-white" aria-label="Done">
      <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
    </span>
  ) : (
    <span className="mt-0.5 size-6 shrink-0 rounded-full border-2 border-line-strong" aria-label="Not done" />
  );
}

function StepAction({ item, profile, canStore, canStaff, onDone, onProfile }: {
  item: ChecklistItem; profile: StoreProfile | null; canStore: boolean; canStaff: boolean;
  onDone: () => Promise<void>; onProfile: (p: StoreProfile) => void;
}) {
  const { me, can } = useAuth();
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (item.done && item.key !== 'logo') return <p className="text-sm text-ink-3">Done. Nothing else needed here.</p>;

  switch (item.key) {
    case 'verify_email':
      return (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">We sent a verification link to <span className="font-medium">{me?.email}</span>. Didn&apos;t get it?</p>
          <Button size="sm" variant="secondary" loading={busy} onClick={async () => {
            setBusy(true);
            try {
              await api('/auth/verify-email/resend', { method: 'POST', body: {}, tenant: false });
              setMsg({ tone: 'good', text: 'A new link is on its way. It expires in 24 hours.' });
            } catch (e) {
              setMsg({ tone: 'bad', text: errorMessage(e) });
            } finally {
              setBusy(false);
            }
          }}>Resend verification email</Button>
          <Button size="sm" variant="ghost" onClick={() => void onDone()}>I&apos;ve verified — refresh</Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      );
    case 'verify_phone':
      return <PhoneVerify currentPhone={me?.phone ?? null} onVerified={() => void onDone()} />;
    case 'logo':
      if (!profile) return <Skeleton className="h-20 w-full" />;
      return (
        <LogoUploader
          logoUrl={profile.storefront.logoUrl} businessName={profile.businessName} canEdit={canStore}
          onChange={(url) => { onProfile({ ...profile, storefront: { ...profile.storefront, logoUrl: url } }); void onDone(); }}
        />
      );
    case 'store_profile':
      return canStore
        ? <ButtonLink href="/settings/store" size="sm">Complete store profile</ButtonLink>
        : <p className="text-sm text-ink-3">Ask the store owner to complete the profile.</p>;
    case 'add_product':
      return can('products:write')
        ? <ButtonLink href="/products/new" size="sm">Add a product</ButtonLink>
        : <p className="text-sm text-ink-3">Ask the owner or store manager to add products.</p>;
    case 'publish_store':
      return canStore
        ? <ButtonLink href="/settings/storefront" size="sm">Review and publish</ButtonLink>
        : <p className="text-sm text-ink-3">Only the owner can publish the storefront.</p>;
    case 'invite_team':
      return canStaff
        ? <ButtonLink href="/settings/team" size="sm">Invite your team</ButtonLink>
        : <p className="text-sm text-ink-3">Only the owner can invite team members.</p>;
    case 'business_verification':
      return canStore
        ? <ButtonLink href="/settings/verification" size="sm" variant={item.status === 'PENDING' ? 'secondary' : 'primary'}>{item.status === 'PENDING' ? 'View request' : 'Verify your business'}</ButtonLink>
        : <p className="text-sm text-ink-3">The store owner can submit business verification.</p>;
    default:
      return null;
  }
}
