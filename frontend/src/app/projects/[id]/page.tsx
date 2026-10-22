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
      <div className="overview-page">
        <div className="overview-intro">
          <div className="overview-identity">
            <p className="overview-eyebrow">Project overview</p>
            <h1>{p.data?.name}</h1>
            <p className="overview-slug">Slug <code>{p.data?.slug}</code></p>
          </div>
          <Link className="action-link action-link-button" href={`/${base}/guided`}>Build with Guided Builder →</Link>
        </div>
      {p.data?.runtimeState === 'suspended' && (
        <p role="alert" id="runtime-suspension">
          Project runtime is suspended. Dashboard management remains available.
          Contact the operator to review and resume.
        </p>
      )}
      <ProjectNextAction
        action={
          p.data?.runtimeState === 'suspended'
            ? {
                label: 'Contact the operator to review runtime suspension',
                href: '#runtime-suspension',
              }
            : status.nextAction
        }
        tested={
          status.tested &&
          status.currentReady &&
          p.data?.runtimeState !== 'suspended'
        }
      />
      <ProjectSetupChecklist steps={status.steps} />
      <div className="overview-details">
        <div className="overview-runtime">
          <h2>Runtime address</h2>
          {p.data && <RuntimeUrl slug={p.data.slug} />}
        </div>
      <section className="overview-api">
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
                {o.noWritableFields
                  ? 'This update operation currently has no writable fields.'
                  : o.ready
                    ? 'Configured — test your API.'
                    : 'Needs attention'}
              </li>
            ))}
          </ul>
        ) : (
          <p>No deployed operations yet. Apply a table and enable an API.</p>
        )}
        {status.tested && <p>Tested during this visit</p>}
      </section>      <section className="overview-attention">
        <h2>Needs attention</h2>
        {status.blockers.length ? (
          <ul>
            {status.blockers.map((s) => (
              <li key={s.id}>
                <Link className="action-link" href={s.href}>{s.label}</Link>: {s.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p>No current setup blockers found in saved metadata.</p>
        )}
        <button
          className="secondary"
          onClick={() => window.dispatchEvent(new Event('dashboard:refresh'))}
        >
          Refresh saved status
        </button>
      </section>      </div>
      <div className="overview-links">

      <p>
        <Link className="action-link" href={`/${base}/docs`}>
          View Docs and copy an integration example
        </Link>
      </p>
      <p>
        <Link className="action-link" href={`/${base}/playground`}>Test your API</Link>
      </p>
      <details>
        <summary>Optional: Workflows</summary>
        <p>{status.optionalSteps[0].detail}</p>
        <Link className="action-link" href={`/${base}/workflows`}>Explore workflows</Link>
      </details>
      </div>
      <details className="project-safety">
        <summary>Using this private-alpha platform</summary>
        <p>
        Private alpha. Use noncritical/test data and keep your own PostgreSQL
        backups. Availability depends on your database. Schema changes are
        limited after first Apply.
        </p>
      </details>
      </div>
    </State>
  );
}
