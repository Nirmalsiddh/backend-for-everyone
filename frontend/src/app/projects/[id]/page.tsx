'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { useData, State } from '@/components/ui';
import type {
  Project,
  Connection,
  Table,
  Endpoint,
  Auth,
  KeyMetadata,
  Workflow,
} from '@/lib/contracts';
import { deriveProjectSetupStatus, type Metadata } from '@/lib/project-setup';
import { useRuntimeSuccesses } from '@/lib/project-visit';
import { RuntimeUrl } from '@/components/runtime-url';
import { ProjectNextAction } from '@/components/project-next-action';
import { ProjectSetupChecklist } from '@/components/project-setup-checklist';
function metadata<T>(
  q: { data?: T; isPending: boolean; error: unknown },
  missing = false,
): Metadata<T | null> {
  const absent =
    missing && q.error instanceof ApiError && q.error.status === 404;
  return {
    data: absent ? null : q.data,
    loading: q.isPending,
    error: !!q.error && !absent,
  };
}
export default function Overview() {
  const { id } = useParams<{ id: string }>();
  const base = `projects/${id}`;
  const p = useData<Project>(base);
  const c = useData<Connection>(base + '/database-connection');
  const t = useData<Table[]>(base + '/schema');
  const e = useData<Endpoint[]>(base + '/endpoints');
  const a = useData<Auth>(base + '/auth');
  const k = useData<KeyMetadata[]>(base + '/api-keys');
  const w = useData<Workflow[]>(base + '/workflows');
  const successes = useRuntimeSuccesses();
  const status = deriveProjectSetupStatus({
    projectId: id,
    connection: metadata(c, true),
    auth: metadata(a, true),
    tables: { data: t.data, loading: t.isPending, error: !!t.error },
    endpoints: { data: e.data, loading: e.isPending, error: !!e.error },
    keys: { data: k.data, loading: k.isPending, error: !!k.error },
    workflows: { data: w.data, loading: w.isPending, error: !!w.error },
    successes,
  });
  return (
    <State query={p}>
      <h1>{p.data?.name}</h1>
      {p.data && <RuntimeUrl slug={p.data.slug} />}
      <ProjectNextAction action={status.nextAction} tested={status.tested} />
      <ProjectSetupChecklist steps={status.steps} />
      <section>
        <h2>Needs attention</h2>
        {status.blockers.length ? (
          <ul>
            {status.blockers.map((s) => (
              <li key={s.id}>
                <Link href={s.href}>{s.label}</Link>: {s.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p>No current setup blockers found in saved metadata.</p>
        )}
        <button
          onClick={() => window.dispatchEvent(new Event('dashboard:refresh'))}
        >
          Refresh saved status
        </button>
      </section>
      <section>
        <h2>Deployed API summary</h2>
        {e.isPending ? (
          <p>Loading…</p>
        ) : e.error ? (
          <p>Could not check deployed operations.</p>
        ) : status.readyOperations.length ? (
          <ul>
            {status.readyOperations.map((o) => (
              <li key={o.id}>
                {o.label} —{' '}
                {o.ready ? 'Configured — test your API.' : 'Needs attention'}
              </li>
            ))}
          </ul>
        ) : (
          <p>No deployed operations yet. Apply a table and enable an API.</p>
        )}
        {status.tested && <p>Tested during this visit</p>}
      </section>
      <p>
        <Link href={`/${base}/docs`}>
          View Docs and copy an integration example
        </Link>
      </p>
      <p>
        <Link href={`/${base}/playground`}>Test your API</Link>
      </p>
      <details>
        <summary>Optional: Workflows</summary>
        <p>{status.optionalSteps[0].detail}</p>
        <Link href={`/${base}/workflows`}>Explore workflows</Link>
      </details>
    </State>
  );
}
