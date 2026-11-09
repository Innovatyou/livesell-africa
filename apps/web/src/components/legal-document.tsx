import Link from 'next/link';
import { COMPANY, LEGAL_EFFECTIVE_DATE, type Block, type LegalDoc } from '@/content/legal';

function Contact({ kind }: { kind: 'support' | 'privacy' }) {
  const email = kind === 'privacy' ? COMPANY.privacyEmail ?? COMPANY.supportEmail : COMPANY.supportEmail;
  return (
    <div className="space-y-2">
      <p>
        {COMPANY.name}
        {COMPANY.address && <>, {COMPANY.address}</>}
      </p>
      {email ? (
        <p>Email: <a href={`mailto:${email}`} className="font-medium text-brand-700 hover:underline">{email}</a></p>
      ) : (
        <p>Send us a message through our <Link href="/contact" className="font-medium text-brand-700 hover:underline">contact form</Link>{kind === 'privacy' ? ' and choose “Privacy / data request” in your message' : ''}.</p>
      )}
      <p>Signed-in sellers can also reach us from their dashboard.</p>
    </div>
  );
}

function renderBlock(b: Block, i: number) {
  if (typeof b === 'string') return <p key={i}>{b}</p>;
  if ('list' in b) return <ul key={i} className="list-disc space-y-2 pl-5">{b.list.map((x) => <li key={x}>{x}</li>)}</ul>;
  return <Contact key={i} kind={b.contact} />;
}

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{doc.title}</h1>
      <p className="mt-2 text-sm text-ink-3">Effective {LEGAL_EFFECTIVE_DATE} · Version {doc.version}</p>

      <nav aria-label="Contents" className="mt-8 rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Contents</p>
        <ol className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
          {doc.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} className="text-ink-2 hover:text-brand-700">{s.title}</a></li>)}
        </ol>
      </nav>

      <div className="mt-8 space-y-4 leading-relaxed text-ink-2">{doc.intro.map((p) => <p key={p}>{p}</p>)}</div>

      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} className="mt-10 scroll-mt-24">
          <h2 className="text-lg font-semibold text-ink">{s.title}</h2>
          <div className="mt-3 space-y-3 leading-relaxed text-ink-2">{s.body.map(renderBlock)}</div>
        </section>
      ))}
    </div>
  );
}
