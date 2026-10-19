'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { api } from '@/lib/api';
import {
  operations,
  type Auth,
  type Table,
  type Endpoint,
  type Operation,
  type Policy,
} from '@/lib/contracts';
import {
  useData,
  useAction,
  ActionState,
  State,
  DirtyGuard,
} from '@/components/ui';
import { PolicyEditor } from '@/features/apis/policy';
const descriptions = {
  list: 'Return multiple records.',
  get: 'Return one record by ID.',
  create: 'Create a new record.',
  update: 'Change fields on one record.',
  delete: 'Delete one record.',
};
const labels = {
  list: 'List',
  get: 'Get',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
};
type Form = {
  enabled: Record<Operation, boolean>;
  policies: Record<Operation, Policy>;
};
function initial(endpoint?: Endpoint): Form {
  return {
    enabled: Object.fromEntries(
      operations.map((op) => [
        op,
        endpoint?.enabledOperations.includes(op) ?? false,
      ]),
    ) as Form['enabled'],
    policies: Object.fromEntries(
      operations.map((op) => [
        op,
        endpoint?.policies?.[op] ?? { mode: 'key_only' },
      ]),
    ) as Form['policies'],
  };
}
function Editor({
  table,
  endpoint,
  projectId,
}: {
  table: Table;
  endpoint?: Endpoint;
  projectId: string;
}) {
  const auth = useData<Auth>(`projects/${projectId}/auth`);
  const authReady =
    !auth.error &&
    !!auth.data?.enabled &&
    auth.data.provisioningStatus === 'ready' &&
    !auth.data.blocked;
  const path = `projects/${projectId}/schema/tables/${table.id}/api`;
  const action = useAction({
    refresh: [`projects/${projectId}/endpoints`],
    success: `${table.name} API configuration saved`,
  });
  const f = useForm<Form>({ defaultValues: initial(endpoint) });
  const enabled = f.watch('enabled');
  const [revision, setRevision] = useState({
    config: endpoint?.revision ?? 0,
    applied: table.appliedRevision,
  });
  const [bulk, setBulk] = useState<Policy>({ mode: 'key_only' });
  useEffect(() => {
    if (!f.formState.isDirty && !action.busy) {
      f.reset(initial(endpoint));
      setRevision({
        config: endpoint?.revision ?? 0,
        applied: table.appliedRevision,
      });
    }
  }, [
    endpoint?.revision,
    table.appliedRevision,
    action.busy,
    f.formState.isDirty,
  ]);
  async function save() {
    let success = false;
    await f.handleSubmit(async (v) => {
      const result = await action.run(() =>
        api<Endpoint>(path, 'PUT', {
          enabledOperations: operations.filter((op) => v.enabled[op]),
          policies: Object.fromEntries(
            operations
              .filter((op) => v.enabled[op])
              .map((op) => [op, v.policies[op]]),
          ),
          expectedAppliedRevision: revision.applied,
          expectedConfigRevision: revision.config,
        }),
      );
      if (result) {
        f.reset(initial(result));
        setRevision({
          config: result.revision,
          applied: table.appliedRevision,
        });
        success = true;
      }
    })();
    return success;
  }
  return (
    <section>
      <h2>{table.name}</h2>
      <p>Choose which operations your API should expose.</p>
      <DirtyGuard
        dirty={f.formState.isDirty}
        save={save}
        discard={() => f.reset()}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p>
          Choose the enabled operations, then configure the access each
          operation grants.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            operations.forEach((op) =>
              f.setValue(`enabled.${op}`, true, { shouldDirty: true }),
            )
          }
        >
          Select all operations
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            operations.forEach((op) =>
              f.setValue(`enabled.${op}`, false, { shouldDirty: true }),
            )
          }
        >
          Disable all operations
        </button>
        <fieldset>
          <legend>Apply one policy to enabled operations</legend>
          <PolicyEditor
            authReady={authReady}
            authHref={`/projects/${projectId}/auth`}
            value={bulk}
            onChange={setBulk}
            fields={table.appliedDefinition?.definition.fields ?? []}
          />
          <button
            type="button"
            onClick={() =>
              operations
                .filter((op) => enabled[op])
                .forEach((op) =>
                  f.setValue(`policies.${op}`, structuredClone(bulk), {
                    shouldDirty: true,
                  }),
                )
            }
          >
            Apply policy to enabled operations
          </button>
        </fieldset>
        {operations.map((op) => (
          <fieldset key={op}>
            <legend>{labels[op]}</legend>
            <p>{descriptions[op]}</p>
            {endpoint?.enabledOperations.includes(op) && (
              <Link
                href={`/projects/${projectId}/playground?target=${encodeURIComponent(`table:${endpoint.id}:${op}`)}`}
              >
                Test this endpoint
              </Link>
            )}
            <label className="check">
              <input type="checkbox" {...f.register(`enabled.${op}`)} />
              Enable {op}
            </label>
            {enabled[op] && (
              <Controller
                control={f.control}
                name={`policies.${op}`}
                render={({ field }) => (
                  <PolicyEditor
                    authReady={authReady}
                    authHref={`/projects/${projectId}/auth`}
                    value={field.value}
                    onChange={field.onChange}
                    fields={table.appliedDefinition?.definition.fields ?? []}
                  />
                )}
              />
            )}
          </fieldset>
        ))}
        <button disabled={action.busy}>Save {table.name} API</button>
      </form>
      <ActionState action={action} />
    </section>
  );
}
export default function Apis() {
  const { id } = useParams<{ id: string }>();
  const t = useData<Table[]>(`projects/${id}/schema`);
  const e = useData<Endpoint[]>(`projects/${id}/endpoints`);
  return (
    <>
      <h1>APIs & authorization</h1>
      <button
        className="secondary"
        onClick={() => {
          void t.refetch();
          void e.refetch();
        }}
      >
        Refresh saved status (keep edits)
      </button>
      <p>
        API keys and application sessions are alternative credentials. Protected
        policies require ready, enabled project authentication.
      </p>
      <State query={t}>
        <State query={e}>
          {!t.data?.some((t) => t.appliedRevision !== null) && (
            <p>Apply a table first.</p>
          )}
          {t.data
            ?.filter((t) => t.appliedRevision !== null)
            .map((table) => (
              <Editor
                key={table.id}
                table={table}
                endpoint={e.data?.find((x) => x.tableId === table.id)}
                projectId={id}
              />
            ))}
        </State>
      </State>
    </>
  );
}
