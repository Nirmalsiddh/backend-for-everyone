'use client';
import { useParams } from 'next/navigation';
import { useData, ErrorBox } from '@/components/ui';
import { ApiDocs } from '@/components/api-docs';
import type { OpenApiDocument } from '@/lib/api-docs';
export default function DocsPage() {
  const { id } = useParams<{ id: string }>();
  const query = useData<OpenApiDocument>(`projects/${id}/openapi`);
  // Never present a previously loaded contract as current after a failed refresh.
  if (query.error) return <ErrorBox error={query.error} />;
  if (query.isPending || !query.data)
    return <p role="status">Loading documentation…</p>;
  return <ApiDocs document={query.data} projectId={id} />;
}
