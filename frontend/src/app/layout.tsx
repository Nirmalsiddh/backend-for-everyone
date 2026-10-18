import { publicRuntimeOrigin } from '@/lib/server/runtime-origin';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './styles.css';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Platform Dashboard' };
export default function RootLayout({ children }: { children: ReactNode }) {
  const runtimeOrigin = publicRuntimeOrigin();
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
