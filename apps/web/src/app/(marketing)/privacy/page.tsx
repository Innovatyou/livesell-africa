import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';
import { PRIVACY } from '@/content/legal';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return <LegalDocument doc={PRIVACY} />;
}
