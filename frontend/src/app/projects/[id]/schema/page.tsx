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
      <h1>Tables & fields</h1>
      <State query={q}>
        {q.data?.length === 0 && (
          <p>Create your first table, or start with the Tasks example.</p>
        )}
        {q.data?.map((t) => (
          <section key={t.id}>
            <Link href={`/projects/${id}/schema/${t.id}`}>{t.name}</Link> ·
            Saved draft ·{' '}
            {t.appliedRevision === null
              ? 'Not applied'
              : 'Current database schema'}
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
