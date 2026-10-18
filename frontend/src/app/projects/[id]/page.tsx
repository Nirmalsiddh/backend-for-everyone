'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { ApiError } from '@/lib/api';
import { useParams } from 'next/navigation';
import { useData, State, ErrorBox } from '@/components/ui';
import type {
  Project,
  Connection,
  Table,
  Endpoint,
  Auth,
  Workflow,
} from '@/lib/contracts';
function Summary({
  label,
  href,
  query,
  describe,
}: {
  label: string;
  href: string;
  query: { isPending: boolean; error: unknown; data?: unknown };
  describe: (value: never) => string;
}) {
  return (
    <section>
      <h2>
        <Link href={href}>{label}</Link>
      </h2>
      {query.isPending ? (
        'Loading…'
      ) : query.error instanceof ApiError && query.error.status === 404 ? (
        <p>Not configured yet. Open this step to get started.</p>
      ) : query.error ? (
        <ErrorBox error={query.error} />
      ) : (
        describe(query.data as never)
      )}
    </section>
  );
}
export default function Overview() {
  const { id } = useParams<{ id: string }>();
  const [runtimeOrigin, setRuntimeOrigin] = useState('');
  useEffect(() => {
    setRuntimeOrigin(
      document
        .querySelector('meta[name="runtime-origin"]')
        ?.getAttribute('content') ?? '',
    );
  }, []);
  const base = `projects/${id}`;
  const p = useData<Project>(base);
  const c = useData<Connection>(base + '/database-connection');
  const t = useData<Table[]>(base + '/schema');
  const e = useData<Endpoint[]>(base + '/endpoints');
  const a = useData<Auth>(base + '/auth');
  const w = useData<Workflow[]>(base + '/workflows');
  return (
    <>
      <State query={p}>
        <h1>{p.data?.name}</h1>
        <p>Slug: {p.data?.slug}</p>
        <p>
          Runtime base URL:{' '}
          <code>
            {runtimeOrigin}/api/{p.data?.slug}
          </code>{' '}
          (Fastify runtime API; the playground uses an internal dashboard relay)
        </p>
      </State>
      <h2>Setup overview</h2>
      <p>
        <Link href={`/${base}/database`}>Connect database</Link> →{' '}
        <Link href={`/${base}/schema`}>Create and apply schema</Link> →{' '}
        <Link href={`/${base}/apis`}>Enable API operations</Link>
      </p>
      <Summary
        label="1. Database"
        href={`/${base}/database`}
        query={c}
        describe={(v: Connection) =>
          `${v.label}: last connection check ${v.lastTestStatus} (not continuous monitoring)`
        }
      />
      <Summary
        label="2. Schema"
        href={`/${base}/schema`}
        query={t}
        describe={(v: Table[]) =>
          `${v.length} managed tables; ${v.filter((x) => x.appliedRevision !== null).length} applied`
        }
      />
      <Summary
        label="3. APIs"
        href={`/${base}/apis`}
        query={e}
        describe={(v: Endpoint[]) =>
          `${v.filter((x) => x.enabledOperations.length > 0).length} configured resources; runtime usability also depends on connection, schema and authentication readiness`
        }
      />
      <Summary
        label="4. Authentication"
        href={`/${base}/auth`}
        query={a}
        describe={(v: Auth) =>
          `${v.enabled ? 'Enabled' : 'Disabled'}; ${v.provisioningStatus}${v.blocked ? '; operator review or schema apply pending' : ''}`
        }
      />
      <Summary
        label="5. Workflows"
        href={`/${base}/workflows`}
        query={w}
        describe={(v: Workflow[]) =>
          `${v.length} workflows; ${v.filter((x) => x.enabled && x.publishedVersionId && x.readiness?.state !== 'blocked').length} published and enabled; ${v.filter((x) => x.readiness?.state === 'blocked').length} blocked`
        }
      />
      <Link href={`/${base}/keys`}>Generate API key</Link> ·{' '}
      <Link href={`/${base}/playground`}>Open playground</Link>
    </>
  );
}
