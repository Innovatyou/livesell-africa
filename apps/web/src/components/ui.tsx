'use client';

import Link from 'next/link';
import { forwardRef, useId } from 'react';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
export { cx };

// ── Button ──
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-600/50',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-sunken disabled:text-ink-4',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink disabled:text-ink-4',
  danger: 'bg-surface text-bad border border-line-strong hover:bg-bad-bg disabled:text-ink-4',
};
const SIZES = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-[15px]' };

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof SIZES;
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium transition-colors disabled:cursor-not-allowed whitespace-nowrap',
        VARIANTS[variant], SIZES[size], className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = 'primary', size = 'md', className, children }: { href: string; variant?: Variant; size?: keyof typeof SIZES; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cx('inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium transition-colors whitespace-nowrap', VARIANTS[variant], SIZES[size], className)}>
      {children}
    </Link>
  );
}

// ── Form controls ──
const control =
  'w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-4 transition-colors focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-100 disabled:bg-sunken disabled:text-ink-3 aria-invalid:border-bad aria-invalid:focus:ring-bad-bg';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx(control, 'h-10', className)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} {...p} className={cx(control, 'min-h-24 py-2', className)} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} {...p} className={cx(control, 'h-10 pr-8', className)} />;
});

/** Label + control + hint/error, wired with ids for screen readers. */
export function Field({ label, hint, error, children, className }: {
  label: string; hint?: React.ReactNode; error?: string | null; className?: string;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const describe = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink-2">{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describe })}
      {error ? <p id={`${id}-err`} className="text-[13px] text-bad">{error}</p> : hint ? <p id={`${id}-hint`} className="text-[13px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

// ── Surfaces ──
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]', className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Feedback ──
type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand';
const BADGE: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2', good: 'bg-good-bg text-good', warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad', info: 'bg-info-bg text-info', brand: 'bg-brand-50 text-brand-700',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', BADGE[tone], className)}>{children}</span>;
}

const ALERT_ICON: Record<'good' | 'warn' | 'bad' | 'info', string> = {
  good: 'M5 13l4 4L19 7', warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  bad: 'M12 8v5m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', info: 'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};
export function Alert({ tone = 'info', title, children, action, className }: { tone?: 'good' | 'warn' | 'bad' | 'info'; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  const box = { good: 'border-brand-200 bg-good-bg', warn: 'border-[#f1dca8] bg-warn-bg', bad: 'border-[#f4c7c1] bg-bad-bg', info: 'border-[#cbd9fb] bg-info-bg' }[tone];
  const ink = { good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info' }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-sm', box, className)}>
      <svg aria-hidden viewBox="0 0 24 24" className={cx('mt-0.5 size-4 shrink-0', ink)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={ALERT_ICON[tone]} /></svg>
      <div className="min-w-0 flex-1 text-ink-2">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={cx('animate-spin', className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity={0.25} strokeWidth={3} />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-sunken', className)} />;
}

export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-ink-3">
      <Spinner className="size-5 text-brand-600" /> {label}…
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-sunken text-ink-3">
        {icon ?? <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" /></svg>}
      </div>
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-ink-3">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert tone="bad" title="Couldn't load this" action={onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}>
      {message}
    </Alert>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight text-ink', className)}>
      <svg aria-hidden viewBox="0 0 32 32" className="size-7">
        <rect width="32" height="32" rx="9" fill="var(--color-brand-600)" />
        <path d="M11 9v14h10" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="22" cy="10" r="3" fill="#7ce0ae" />
      </svg>
      <span>LiveSell<span className="text-brand-600"> Africa</span></span>
    </span>
  );
}
