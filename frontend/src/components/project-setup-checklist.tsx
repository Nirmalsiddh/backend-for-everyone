import Link from 'next/link';
import type { SetupStep } from '@/lib/project-setup';
export function ProjectSetupChecklist({ steps }: { steps: SetupStep[] }) {
  return (
    <section className="setup-checklist">
      <h2>Setup checklist</h2>
      <ol>
        {steps.map((s) => (
          <li key={s.id}>
            <div className="setup-step-heading">
              <Link className="action-link" href={s.href}>{s.label}</Link>
              <span className="setup-step-status" data-status={s.status}>{s.status}</span>
            </div>
            <p>{s.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
