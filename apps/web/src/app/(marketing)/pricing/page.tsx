import type { Metadata } from 'next';
import { PricingLive, PricingTable } from '@/components/pricing-table';
import { Alert } from '@/components/ui';
import type { Plan } from '@/lib/types';

export const metadata: Metadata = { title: 'Pricing' };
export const revalidate = 300;

const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

async function getPlans(): Promise<Plan[] | null> {
  try {
    const res = await fetch(`${API}/api/v1/plans`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return (await res.json()) as Plan[];
  } catch {
    return null;
  }
}

export default async function PricingPage() {
  const plans = await getPlans();
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Simple pricing for every seller</h1>
        <p className="mt-3 text-ink-2">Start with a free trial. Change or cancel your plan any time from your dashboard.</p>
      </div>
      <div className="mt-10">
        {plans === null ? (
          // Server render couldn't reach the API (e.g. at build time): load live in the browser instead of caching an error.
          <PricingLive />
        ) : plans.length === 0 ? (
          <Alert tone="info" className="mx-auto max-w-xl">Plans are being updated. Please check back shortly.</Alert>
        ) : (
          <PricingTable plans={plans} />
        )}
      </div>
      <p className="mt-8 text-center text-sm text-ink-3">Prices in Naira. Annual billing is charged once a year.</p>
    </div>
  );
}
