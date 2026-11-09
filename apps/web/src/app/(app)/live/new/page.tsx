'use client';

import Link from 'next/link';
import { LiveSessionForm } from '@/components/live-session-form';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function NewLivePage() {
  const { can } = useAuth();
  if (!can('live:manage')) return <Card><EmptyState title="Your role can't schedule lives" /></Card>;
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm"><Link href="/live" className="text-ink-3 hover:text-ink">← Live selling</Link></p>
      <PageHeader title="Schedule a live" />
      <LiveSessionForm />
    </div>
  );
}
