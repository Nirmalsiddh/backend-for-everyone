import type { Workflow, Definition, Preview, Table } from '@/lib/contracts';
export function CapabilitySummary({
  workflow,
  definition,
  preview,
  tables,
}: {
  workflow: Workflow;
  definition: Definition;
  preview: Preview;
  tables: Table[];
}) {
  return (
    <>
      <p>
        POST /{workflow.path} ·{' '}
        {definition.auth === 'key_only'
          ? 'API key required'
          : 'Signed-in user required'}{' '}
        · Required key scope:{' '}
        {preview.requiredScope === 'read_write'
          ? 'Read and write'
          : 'Read only'}
      </p>
      <p className="warning">
        {workflow.enabled
          ? 'Publishing replaces the currently enabled live workflow immediately.'
          : 'Publishing saves an inactive version; enable it explicitly.'}{' '}
        Workflow permissions are independent of generic CRUD permissions.
      </p>
      <ul>
        {preview.operations?.map((op, index) => {
          const table = tables.find((t) => t.id === op.tableId);
          return (
            <li key={op.stepId}>
              {op.type === 'query' ? 'Read' : 'Write'}: {op.type}{' '}
              {table?.name ?? 'Unavailable table'} ·{' '}
              {op.access.mode === 'owner'
                ? `Owner only (${table?.appliedDefinition?.definition.fields.find((f) => f.id === op.access.ownerFieldId)?.name ?? 'Choose field'})`
                : op.access.mode === 'authenticated'
                  ? 'All rows accessible to signed-in users'
                  : 'API key access'}
              {op.access.allowAdmin ? ' · Admin bypass enabled' : ''}
            </li>
          );
        })}
      </ul>
      <p>
        Schema dependencies:{' '}
        {preview.schemaDependencies
          .map(
            (d) =>
              `${tables.find((t) => t.id === d.tableId)?.name ?? 'Unavailable table'} (database version ${d.appliedRevision})`,
          )
          .join(', ') || 'None'}
      </p>
    </>
  );
}
