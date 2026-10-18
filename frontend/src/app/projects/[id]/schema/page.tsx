'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { Table } from '@/lib/contracts';
import { useData, State } from '@/components/ui';
import { SchemaEditor } from '@/features/schema/editor';
export default function Schema() {
  const { id } = useParams<{ id: string }>();
  const path = `projects/${id}/schema`;
  const q = useData<Table[]>(path);
  const router = useRouter();
  return (
    <>
      <h1>Schema Builder</h1>
      <State query={q}>
        {q.data?.length === 0 && (
          <p>
            No tables yet. Create your first table below, preview the change,
            then apply it.
          </p>
        )}
        {q.data?.map((t) => (
          <section key={t.id}>
            <Link href={`/projects/${id}/schema/${t.id}`}>{t.name}</Link> ·
            Draft {t.draftRevision} ·{' '}
            {t.appliedRevision === null
              ? 'Not applied'
              : `Applied ${t.appliedRevision}`}
          </section>
        ))}
      </State>
      <section>
        <h2>Create table</h2>
        <SchemaEditor
          path={path + '/tables'}
          onCreated={(t) => router.push(`/projects/${id}/schema/${t.id}`)}
        />
      </section>
    </>
  );
}
