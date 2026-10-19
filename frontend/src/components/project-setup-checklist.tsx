import Link from 'next/link';
import type { SetupStep } from '@/lib/project-setup';
export function ProjectSetupChecklist({ steps }: { steps: SetupStep[] }) {
  return (
    <section>
      <h2>Setup checklist</h2>
      <ol>
        {steps.map((s) => (
          <li key={s.id}>
            <Link href={s.href}>{s.label}</Link> — <strong>{s.status}</strong>
            <p>{s.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
