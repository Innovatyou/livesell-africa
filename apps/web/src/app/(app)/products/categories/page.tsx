'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Alert, Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Category } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function CategoriesPage() {
  const { can } = useAuth();
  const canWrite = can('products:write');
  const list = useApi<Category[]>('/categories');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; parentId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      await list.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const byId = new Map((list.data ?? []).map((c) => [c.id, c]));
  const label = (c: Category) => (c.parentId && byId.get(c.parentId) ? `${byId.get(c.parentId)!.name} › ${c.name}` : c.name);

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm"><Link href="/products" className="text-ink-3 hover:text-ink">← Products</Link></p>
      <PageHeader title="Categories" description="Group products on your storefront, e.g. Bags, Shoes, Dresses." />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      {canWrite && (
        <Card className="mb-6 p-4">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run('create', () => api('/categories', { method: 'POST', body: { name: name.trim(), parentId: parentId || null } }).then(() => { setName(''); setParentId(''); }), `Category “${name.trim()}” added.`); }}>
            <Input aria-label="Category name" placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select aria-label="Parent category" className="sm:w-56" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top level</option>{list.data?.filter((c) => !c.parentId).map((c) => <option key={c.id} value={c.id}>Inside {c.name}</option>)}
            </Select>
            <Button type="submit" loading={busy === 'create'} disabled={name.trim().length < 2}>Add</Button>
          </form>
        </Card>
      )}
      <Card>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : list.data.length === 0 ? <EmptyState title="No categories yet">Categories are optional; customers can still search all your products.</EmptyState>
          : (
            <ul className="divide-y divide-line">
              {list.data.map((c) => (
                <li key={c.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  {editing?.id === c.id ? (
                    <form className="flex flex-1 flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void run(`edit-${c.id}`, () => api(`/categories/${c.id}`, { method: 'PATCH', body: { name: editing.name.trim(), parentId: editing.parentId || null } }).then(() => setEditing(null)), 'Category updated.'); }}>
                      <Input aria-label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                      <Select aria-label="Parent" className="sm:w-48" value={editing.parentId} onChange={(e) => setEditing({ ...editing, parentId: e.target.value })}>
                        <option value="">Top level</option>{list.data!.filter((x) => x.id !== c.id && !x.parentId).map((x) => <option key={x.id} value={x.id}>Inside {x.name}</option>)}
                      </Select>
                      <Button type="submit" size="sm" loading={busy === `edit-${c.id}`} disabled={editing.name.trim().length < 2}>Save</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <>
                      <div><p className="font-medium">{label(c)}</p><p className="text-[13px] text-ink-3">{c._count.products} product{c._count.products === 1 ? '' : 's'}</p></div>
                      {canWrite && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setEditing({ id: c.id, name: c.name, parentId: c.parentId ?? '' })}>Edit</Button>
                          <Button size="sm" variant="ghost" loading={busy === `del-${c.id}`} disabled={c._count.products > 0} title={c._count.products ? 'Move its products first' : undefined}
                            onClick={() => { if (window.confirm(`Delete ${c.name}?`)) void run(`del-${c.id}`, () => api(`/categories/${c.id}`, { method: 'DELETE' }), 'Category deleted.'); }}>Delete</Button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}
