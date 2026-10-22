import { publicRuntimeOrigin } from '@/lib/server/runtime-origin';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './styles.css';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Backend for Everyone' };
export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeOrigin = publicRuntimeOrigin();
  return (
    <html lang="en">
      <head>
        <meta name="runtime-origin" content={runtimeOrigin} />
      </head>
      <body>
        <header className="app-header">
          <a className="app-brand" href="/projects">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Backend</span>
          </a>
        </header>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
