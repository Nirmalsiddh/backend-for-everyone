'use client';
import Link from 'next/link';
import { TypeScriptClient } from '@/components/typescript-client';
import { useParams } from 'next/navigation';
import { useData, ErrorBox } from '@/components/ui';
import { ApiDocs } from '@/components/api-docs';
import type { OpenApiDocument } from '@/lib/api-docs';
export default function DocsPage() {
  const { id } = useParams<{ id: string }>();
  const query = useData<OpenApiDocument>(`projects/${id}/openapi`);
  // Never present a previously loaded contract as current after a failed refresh.
  if (query.error)
    return (
      <>
        <TypeScriptClient key={id} projectId={id} />
        <ErrorBox error={query.error} />
        <p>
          Docs are unavailable while deployed metadata is blocked. Review{' '}
          <Link href={`/projects/${id}`}>Overview blockers</Link>,{' '}
          <Link href={`/projects/${id}/auth`}>application authentication</Link>,
          or{' '}
          <Link href={`/projects/${id}/workflows`}>
            republish or disable a stale workflow
          </Link>
          . Healthy APIs may still execute; this page does not publish a partial
          contract.
        </p>
        <button onClick={() => void query.refetch()}>Refresh Docs</button>
      </>
    );
  if (query.isPending || !query.data)
    return <><TypeScriptClient key={id} projectId={id} /><p role="status">Loading documentation…</p></>;
  return <><TypeScriptClient key={id} projectId={id} /><ApiDocs document={query.data} projectId={id} /></>;
}
