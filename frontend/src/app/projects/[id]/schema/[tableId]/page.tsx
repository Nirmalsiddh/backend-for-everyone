'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import type { Table } from '@/lib/contracts';
import { useData, State } from '@/components/ui';
import { SchemaEditor } from '@/features/schema/editor';
export default function TablePage() {
  const { id, tableId } = useParams<{ id: string; tableId: string }>();
  const path = `projects/${id}/schema/tables/${tableId}`;
  const q = useData<Table>(path);
  const [reload, setReload] = useState(0);
  return (
    <>
      <h1>Tables &amp; fields</h1>
      <button type="button" onClick={() => void q.refetch()}>
        Refresh saved status (keep edits)
      </button>
      <button
        className="secondary"
        onClick={async () => {
          if (confirm('Reload saved data? Unsaved edits will be discarded.')) {
            await q.refetch();
            setReload((n) => n + 1);
          }
        }}
      >
        Reload saved data
      </button>
      <State query={q}>
        {q.data && (
          <SchemaEditor
            key={`${tableId}-${reload}`}
            path={path}
            table={q.data}
          />
        )}
      </State>
    </>
  );
}
