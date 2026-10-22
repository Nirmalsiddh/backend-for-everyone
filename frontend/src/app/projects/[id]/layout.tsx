'use client';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const guided = usePathname() === `/projects/${id}/guided`;
  const links = guided
    ? [['guided', 'Guided Builder'], ['', 'Overview'], ['database', 'Database']]
    : [
      ['guided', 'Guided Builder'],
      ['', 'Overview'],
      ['database', 'Database'],
      ['schema', 'Tables & fields'],
      ['apis', 'APIs'],
      ['auth', 'App authentication'],
      ['keys', 'API keys'],
      ['docs', 'Docs'],
      ['playground', 'Playground'],
      ['workflows', 'Workflows'],
      ['observability', 'Observability'],
    ];
  return (
    <div className="shell">
      <aside aria-label="Project navigation">
        <Link href="/projects">All projects</Link>
        {links.map(([path, label]) => (
          <Link key={path} href={`/projects/${id}${path ? '/' + path : ''}`}>
            {label}
          </Link>
        ))}
      </aside>
      <main>{children}</main>
    </div>
  );
}
