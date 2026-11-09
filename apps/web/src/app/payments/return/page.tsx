import type { Metadata } from 'next';
import { PaymentReturn } from '@/components/payment-return';

export const metadata: Metadata = { title: 'Payment', robots: { index: false, follow: false } };

export default function PaymentReturnPage() {
  return <PaymentReturn />;
}
