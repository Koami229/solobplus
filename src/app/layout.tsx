import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SOLOB+ | One Leg on School, One Leg on Business',
  description:
    'African-oriented AI ecosystem: SOLOB School (Academic Learning Only) & SOLOB Business (Managed AI Talent & Project Delivery), powered by SOLOB Core.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body className="min-h-screen antialiased selection:bg-emerald-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}
