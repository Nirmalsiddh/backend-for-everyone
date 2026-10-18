import type { ReactNode } from 'react';
import { requireUser } from '@/lib/server/auth';
import { LogoutButton } from '@/components/platform-auth';
export const dynamic = 'force-dynamic';
export default async function ProjectsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return <><div className="card"><span>{user.email}</span> <LogoutButton /></div>{children}</>;
}
