import type { ReactNode } from 'react';
import { requireUser } from '@/lib/server/auth';
import { AccountControl } from '@/components/account-control';
export const dynamic = 'force-dynamic';
export default async function ProjectsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();
  return (
    <>
      <AccountControl email={user.email} />
      {children}
    </>
  );
}
