import Link from 'next/link';
import type { SetupAction } from '@/lib/project-setup';
export function ProjectNextAction({
  action,
  tested,
}: {
  action: SetupAction;
  tested: boolean;
}) {
  return (
    <section aria-labelledby="next-action">
      <h2 id="next-action">Next action</h2>
      <Link href={action.href}>{action.label}</Link>
      <p>
        {tested
          ? 'Your API is ready to try in your application.'
          : 'Follow the steps below to configure and test your API.'}
      </p>
    </section>
  );
}
