import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { THEME_BOOT } from '@/components/theme-toggle';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'LiveSell Africa — Turn every live session into sales', template: '%s · LiveSell Africa' },
  description: 'The operating system for social commerce and live selling in Nigeria: orders, payments, inventory and customers from one dashboard.',
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#0e7a4d' }, { media: '(prefers-color-scheme: dark)', color: '#0d1210' }],
  width: 'device-width', initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Saved Light/Dark choice, applied before paint (no flash). Static string, no user input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-dvh font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
