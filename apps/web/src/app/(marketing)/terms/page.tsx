import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';
import { TERMS } from '@/content/legal';

export const metadata: Metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return <LegalDocument doc={TERMS} />;
}
