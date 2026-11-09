'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CHANNEL_LABEL, failureReason, messageTypeLabel, NOTIFICATION_STATUS } from '@/lib/messaging-labels';
import type { NotificationItem, ReminderResult } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** Messages LiveSell sent the customer about this order, and a manual payment reminder while it is unpaid. */
export function OrderMessages({ orderId, status }: { orderId: string; status: string }) {
  const { can } = useAuth();
  const list = useApi<NotificationItem[]>(`/orders/${orderId}/notifications`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);
  const canRemind = can('orders:create') && status === 'PENDING_PAYMENT';

  async function remind() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<ReminderResult>(`/orders/${orderId}/notify`, { method: 'POST', body: { event: 'PAYMENT_REMINDER' } });
      const ok = r.results.filter((x) => x.status !== 'FAILED' && !x.duplicate);
      setMsg(r.results.length === 0
        ? { tone: 'warn', text: 'No message was sent: the customer has no phone or email we can use, or has opted out.' }
        : ok.length
          ? { tone: 'good', text: `Reminder sent by ${ok.map((x) => CHANNEL_LABEL[x.channel]).join(' and ')}.` }
          : { tone: 'bad', text: `Not sent: ${failureReason(r.results[0].error)}` });
      void list.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Customer messages"
        description="WhatsApp, SMS and email updates sent automatically about this order."
        action={canRemind && <Button size="sm" variant="secondary" loading={busy} onClick={() => void remind()}>Send payment reminder</Button>}
      />
      {msg && <div className="px-5 pt-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
        : !list.data ? <PageLoading />
        : list.data.length === 0 ? <EmptyState title="No messages yet">Updates go out when the order is placed, paid, dispatched or delivered.</EmptyState>
        : (
          <ul className="divide-y divide-line">
            {list.data.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p><span className="font-medium">{messageTypeLabel(n.type)}</span> <span className="text-ink-3">· {CHANNEL_LABEL[n.channel]} to {n.destination}</span></p>
                  {n.status === 'FAILED' && <p className="text-[13px] text-bad">{failureReason(n.error)}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={NOTIFICATION_STATUS[n.status][1]}>{NOTIFICATION_STATUS[n.status][0]}</Badge>
                  <span className="text-[12px] text-ink-3">{when(n.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
