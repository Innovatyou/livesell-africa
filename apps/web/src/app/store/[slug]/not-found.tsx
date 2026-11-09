import Link from 'next/link';
import { Logo } from '@/components/ui';

export default function StoreNotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4">
      <Logo />
      <h1 className="text-2xl font-semibold tracking-tight">This store isn&apos;t available</h1>
      <p className="text-ink-2">The link may be wrong, or the store isn&apos;t open right now. Check the link with the seller.</p>
      <Link href="/" className="font-medium text-brand-700 hover:underline">Go to LiveSell Africa</Link>
    </div>
  );
}
