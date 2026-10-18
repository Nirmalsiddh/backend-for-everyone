'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="shell">
      <aside>
        <Link href="/projects">All projects</Link>
        {[
          ['', 'Overview'],
          ['database', 'Database'],
          ['schema', 'Schema'],
          ['apis', 'APIs & policies'],
          ['keys', 'API keys'],
          ['auth', 'Authentication'],
          ['workflows', 'Workflows'],
          ['docs', 'Docs'],
          ['playground', 'Playground'],
        ].map(([path, label]) => (
          <Link key={path} href={`/projects/${id}${path ? '/' + path : ''}`}>
            {label}
          </Link>
        ))}
      </aside>
      <main>{children}</main>
    </div>
  );
}
