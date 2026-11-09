import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'LiveSell Africa — Turn every live session into sales', template: '%s · LiveSell Africa' },
  description: 'The operating system for social commerce and live selling in Nigeria: orders, payments, inventory and customers from one dashboard.',
};

export const viewport: Viewport = { themeColor: '#0e7a4d', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NG" className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
