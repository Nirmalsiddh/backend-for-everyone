import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './styles.css';
export const metadata = { title: 'Platform Dashboard' };
export default function RootLayout({ children }: { children: ReactNode }) {
  let runtimeOrigin = '';
  try {
    runtimeOrigin = new URL(
      process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3000',
    ).origin;
  } catch {}
  return (
    <html lang="en">
      <head>
        <meta name="runtime-origin" content={runtimeOrigin} />
      </head>
      <body>
        <header>
          <a href="/projects">API Builder</a>
        </header>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
