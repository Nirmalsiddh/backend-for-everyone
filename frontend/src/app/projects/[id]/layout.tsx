'use client';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useRef, type ReactNode } from 'react';
export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const guided = pathname === `/projects/${id}/guided`;
  const drawer = useRef<HTMLDialogElement>(null);
  const groups = [
    { label: 'Project', links: [['', 'Overview'], ['guided', 'Guided Builder']] },
    { label: 'Build', links: [['database', 'Database'], ['schema', 'Tables & fields'], ['apis', 'APIs'], ['auth', 'App authentication']] },
    { label: 'Develop', links: [['keys', 'API keys'], ['playground', 'Playground'], ['docs', 'Docs'], ['workflows', 'Workflows'], ['observability', 'Observability']] },
  ];
  function navigation(mobile = false) {
    return (
      <nav aria-label="Project navigation">
        <Link className="nav-item" href="/projects" onClick={mobile ? () => drawer.current?.close() : undefined}>← All projects</Link>
        {groups.map((group) => {
          const links = group.links.filter(([path]) => !guided || ['', 'guided', 'database'].includes(path));
          if (!links.length) return null;
          return <div className="nav-group" key={group.label}>
            <p className="nav-group-label">{group.label}</p>
            {links.map(([path, label]) => {
              const href = `/projects/${id}${path ? '/' + path : ''}`;
              const active = pathname === href || (!!path && pathname.startsWith(href + '/'));
              return <Link key={path} className="nav-item" aria-current={active ? 'page' : undefined} href={href} onClick={mobile ? () => drawer.current?.close() : undefined}>{label}</Link>;
            })}
          </div>;
        })}
      </nav>
    );
  }
  return (
    <>
      <button type="button" className="mobile-nav-trigger" aria-haspopup="dialog" onClick={() => drawer.current?.showModal()}><span aria-hidden="true">☰</span><span className="mobile-nav-label">Project navigation</span></button>
      <dialog ref={drawer} className="mobile-drawer" aria-label="Project navigation menu">
        <button type="button" className="secondary drawer-close" onClick={() => drawer.current?.close()}>Close navigation</button>
        {navigation(true)}
      </dialog>
      <div className="shell">
        <aside className="app-sidebar">{navigation()}</aside>
        <main>{children}</main>
      </div>
    </>
  );
}
