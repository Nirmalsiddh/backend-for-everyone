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
          <strong className="badge">Local Operator Mode</strong>
        </header>
        <p className="operator-warning" role="note">
          Local Operator Mode: keep this dashboard private. Everyone with access
          acts as the configured operator. Use an authenticated access layer and
          disposable databases for external testing.
        </p>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
