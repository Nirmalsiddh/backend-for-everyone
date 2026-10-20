'use client';
import { validateIndexForms } from '@/lib/schema-indexes';
import { Indexes } from './indexes';
import { MutationBoundary } from '@/components/ui';
import { fieldTypes } from '../../../../shared/public-contracts.js';
import { useEffect, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { api } from '@/lib/api';
import type { Table, ManagedIndex } from '@/lib/contracts';
import {
  emptyField,
  tasksPreset,
  ownershipWarning,
  mayReplacePreset,
  toForm,
  validateFields,
  type FieldForm,
} from '@/lib/schema-form';
import { useAction, ActionState, DirtyGuard } from '@/components/ui';
const types = [...fieldTypes, 'reference'] as const;
export function SchemaEditor({
  path,
  table,
  onCreated,
}: {
  path: string;
  table?: Table;
  onCreated?: (t: Table) => void;
}) {
  const [targets, setTargets] = useState<{
    targets: { id: string; name: string }[];
    unavailable: boolean;
  } | null>(null);
  const [targetError, setTargetError] = useState(false);
  const [targetRefresh, refreshTargets] = useState(0);
  useEffect(() => {
    let active = true;
    setTargets(null);
    setTargetError(false);
    const base = path.split('/schema')[0] + '/schema';
    api<{ targets: { id: string; name: string }[]; unavailable: boolean }>(
      base + '/reference-targets',
    )
      .then((result) => {
        if (active) setTargets(result);
      })
      .catch(() => {
        if (active) setTargetError(true);
      });
    return () => {
      active = false;
    };
  }, [path, targetRefresh]);
  const [choosePreset, setChoosePreset] = useState(false);
  const [savedRevision, setSavedRevision] = useState(table?.draftRevision);
  const action = useAction({
    refresh: [path, path.split('/schema')[0] + '/schema'],
    success: 'Schema operation completed; saved status refreshed',
  });
  const [preview, setPreview] = useState<{
    sql: string;
    planHash: string;
    draftRevision: number;
    actions?: { kind: string; field?: string; fields?: string[] }[];
    relationships?: { field: string; target: string; nullable: boolean }[];
  } | null>(null);
  const f = useForm<{ name: string; fields: FieldForm[]; indexes: ManagedIndex[] }>({
    defaultValues: {
      name: table?.name ?? '',
      fields: table?.fields.map(toForm) ?? [],
      indexes: table?.indexes ?? [],
    },
  });
  const rows = useFieldArray({
    control: f.control,
    name: 'fields',
    keyName: 'formKey',
  });
  const values = f.watch();
  useEffect(() => {
    if (table && !f.formState.isDirty && !action.busy) {
      f.reset({ name: table.name, fields: table.fields.map(toForm), indexes: table.indexes ?? [] });
      setSavedRevision(table.draftRevision);
    }
  }, [table?.draftRevision, action.busy, f.formState.isDirty]);
  const applied = new Set(
    table?.appliedDefinition?.definition.fields.flatMap((x) => x.id ? [x.id] : []),
  );
  async function saveValues(v: { name: string; fields: FieldForm[]; indexes: ManagedIndex[] }) {
    return action.run(
      async () => {
        const fields = validateFields(v.fields);
        validateIndexForms(v.indexes, fields);
        const t = await api<Table>(
          table ? path + '/draft' : path,
          table ? 'PUT' : 'POST',
          {
            name: v.name,
            fields,
            indexes: v.indexes.map(({ specificationVersion: _, ...index }) => index),
            ...(table ? { expectedDraftRevision: savedRevision } : {}),
          },
        );
        f.reset({ name: t.name, fields: t.fields.map(toForm), indexes: t.indexes ?? [] });
        setSavedRevision(t.draftRevision);
        setPreview(null);
        return t;
      },
      onCreated,
      table ? 'Schema draft saved' : 'Table draft created',
    );
  }
  async function saveForNavigation() {
    let success = false;
    await f.handleSubmit(async (v) => {
      success = !!(await saveValues(v));
    })();
    return success;
  }
  return (
    <MutationBoundary busy={action.busy}>
      <DirtyGuard
        dirty={f.formState.isDirty}
        save={table ? saveForNavigation : undefined}
        discard={() => f.reset()}
      />
      {!table && (
        <section>
          <button type="button" onClick={() => setChoosePreset(true)}>
            Start with a Tasks example
          </button>
          {choosePreset && (
            <fieldset>
              <legend>Choose how Tasks will be accessed</legend>
              <p>
                These choices only fill the unsaved form. Save, Apply, API
                access, and authentication remain separate actions.
              </p>
              {(['owned', 'server'] as const).map((kind) => (
                <div key={kind}>
                  <p>
                    {kind === 'owned'
                      ? 'Use this when signed-in users should only access their own tasks.'
                      : 'Use this when your trusted server will call the API with a project API key.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !mayReplacePreset(f.formState.isDirty, () =>
                          confirm(
                            'Replace your existing unsaved table edits with the Tasks example?',
                          ),
                        )
                      )
                        return;
                      const preset = tasksPreset(kind);
                      f.setValue('name', preset.name, { shouldDirty: true });
                      f.setValue('fields', preset.fields, {
                        shouldDirty: true,
                      });
                      setChoosePreset(false);
                    }}
                  >
                    {kind === 'owned'
                      ? 'Use user-owned tasks'
                      : 'Use server-controlled tasks'}
                  </button>
                </div>
              ))}
            </fieldset>
          )}
        </section>
      )}
      <form onSubmit={f.handleSubmit(saveValues)}>
        <label>
          Table name
          <input
            {...f.register('name')}
            required
            disabled={table?.appliedRevision != null}
          />
        </label>
        <p>tasks becomes /tasks in your API.</p>
        <p className="warning" role="note">
          {ownershipWarning}
        </p>
        <p className="warning">
          Applied fields cannot be renamed, dropped, or have their types changed. You may add nullable fields without defaults, add a managed index, or make one existing field required per Apply. For owner-protected records, add a UUID
          ownership field such as owner_id before applying; existing rows will
          not acquire an owner automatically.
        </p>
        <p>
          Read-only generated field: <code>id UUID PRIMARY KEY</code>, generated
          automatically. Clients do not provide it.
        </p>
        {rows.fields.map((row, i) => {
          const locked = !!row.id && applied.has(row.id);
          const value = values.fields[i];
          return (
            <div key={row.formKey}><fieldset disabled={locked || action.busy}>
              <legend>
                Field {i + 1}
                {locked ? ' · applied, read-only' : ''}
              </legend>
              <div className="row">
                <label>
                  Field name
                  <input {...f.register(`fields.${i}.name`)} required />
                </label>
                <label>
                  Type
                  <select
                    {...f.register(`fields.${i}.type`, {
                      onChange: (event) => {
                        if (
                          event.target.value === 'reference' &&
                          (value.unique || value.defaultKind !== 'none') &&
                          !confirm(
                            'Reference fields cannot have uniqueness or defaults. Clear these settings?',
                          )
                        ) {
                          f.setValue(`fields.${i}.type`, value.type);
                          return;
                        }
                        f.setValue(`fields.${i}.unique`, false, {
                          shouldDirty: true,
                        });
                        f.setValue(`fields.${i}.defaultKind`, 'none', {
                          shouldDirty: true,
                        });
                      },
                    })}
                  >
                    {types.map((t) => (
                      <option key={t} value={t}>
                        {t === 'reference' ? 'Reference' : t}
                      </option>
                    ))}
                  </select>
                </label>
                {value.type === 'reference' && (
                  <div>
                    <label>
                      Target table
                      <select
                        {...f.register(`fields.${i}.targetTableId`)}
                        required
                        disabled={!targets || targetError}
                      >
                        <option value="">Choose an applied table</option>
                        {targets?.targets
                          .filter((t) => t.id !== table?.id)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    {!targets && !targetError && (
                      <p role="status">Checking reference targets…</p>
                    )}
                    {targetError && (
                      <p role="alert">
                        Could not check reference targets. Check your database
                        connection.
                      </p>
                    )}
                    {targets &&
                      !targets.targets.some((t) => t.id !== table?.id) && (
                        <p>
                          No eligible applied tables. Apply a target table
                          first.
                        </p>
                      )}
                    {targets?.unavailable && (
                      <p role="status">
                        Some tables need attention and cannot be selected.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => refreshTargets((n) => n + 1)}
                    >
                      Refresh reference targets
                    </button>
                    <p>Delete behavior: Prevent deletion while referenced</p>
                    <p>
                      A relationship verifies that the referenced record exists.
                      It does not grant access to that record.
                    </p>
                    {table?.appliedRevision != null && (
                      <p>
                        Existing records will have no reference until you set
                        one.
                      </p>
                    )}
                  </div>
                )}
                {value.type === 'varchar' && (
                  <label>
                    Length
                    <input
                      type="number"
                      {...f.register(`fields.${i}.length`)}
                      min={1}
                      max={10000}
                    />
                  </label>
                )}
                {value.type === 'decimal' && (
                  <>
                    <label>
                      Precision
                      <input
                        type="number"
                        {...f.register(`fields.${i}.precision`)}
                        min={1}
                        max={38}
                      />
                    </label>
                    <label>
                      Scale
                      <input
                        type="number"
                        {...f.register(`fields.${i}.scale`)}
                        min={0}
                      />
                    </label>
                  </>
                )}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!value.nullable}
                  onChange={(e) =>
                    f.setValue(`fields.${i}.nullable`, !e.target.checked, {
                      shouldDirty: true,
                    })
                  }
                  disabled={table?.appliedRevision != null}
                />
                Required
              </label>
              <small>
                Cannot be null. Without a default, provide it when creating a
                record.
              </small>
              <label className="check">
                <input
                  type="checkbox"
                  {...f.register(`fields.${i}.unique`)}
                  disabled={
                    table?.appliedRevision != null ||
                    value.type === 'jsonb' ||
                    value.type === 'reference'
                  }
                />
                Unique
              </label>
              <label>
                Default
                <select
                  {...f.register(`fields.${i}.defaultKind`)}
                  disabled={
                    table?.appliedRevision != null || value.type === 'reference'
                  }
                >
                  <option value="none">None</option>
                  <option value="literal">Typed literal</option>
                  {value.type === 'timestamp' && (
                    <option value="current_timestamp">Current timestamp</option>
                  )}
                </select>
              </label>
              <small>Used when this field is omitted.</small>
              {value.defaultKind === 'literal' && (
                <label>
                  Default value
                  {value.type === 'boolean' ? (
                    <select {...f.register(`fields.${i}.defaultText`)}>
                      <option value="">Choose boolean</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : value.type === 'jsonb' ? (
                    <textarea
                      {...f.register(`fields.${i}.defaultText`)}
                      required
                      aria-label="JSON default"
                    />
                  ) : (
                    <input
                      type={value.type === 'date' ? 'date' : 'text'}
                      {...f.register(`fields.${i}.defaultText`)}
                      required={!['text', 'varchar'].includes(value.type)}
                    />
                  )}
                  <small>
                    Bigint/decimal stay strings; JSONB accepts JSON; timestamps
                    require timezone.
                  </small>
                </label>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => rows.remove(i)}
              >
                Remove field
              </button>
            </fieldset>
            {locked && table?.appliedDefinition?.definition.fields.find((field) => field.id === row.id)?.nullable && <label>
              <input type="checkbox" checked={!value.nullable} disabled={action.busy} onChange={(event) => f.setValue(`fields.${i}.nullable`, !event.target.checked, { shouldDirty: true })} />
              Make {value.name} required · All existing rows must already have a value.
            </label>}
            </div>
          );
        })}
        <button
          type="button"
          className="secondary"
          disabled={rows.fields.length >= 100 || action.busy}
          onClick={() => rows.append(emptyField())}
        >
          Add field
        </button>
        <Indexes indexes={values.indexes} fields={table?.fields ?? []} applied={table?.appliedDefinition?.definition.indexes ?? []}
          appliedFieldIds={table?.appliedDefinition ? applied : undefined} busy={action.busy}
          attention={['failed', 'outcome_unknown'].includes(table?.applyStatus?.status ?? '')}
          onChange={(indexes) => f.setValue('indexes', indexes, { shouldDirty: true })} />
        <button disabled={action.busy}>
          {table ? 'Save draft' : 'Create table draft'}
        </button>
      </form>
      {table && (
        <>
          {savedRevision !== table.draftRevision && (
            <p className="warning">
              The saved server draft changed. Your edits are preserved; reload
              and review before saving.
            </p>
          )}
          {table.applyStatus && (
            <p role="status">
              Latest schema operation:{' '}
              {
                {
                  applying: 'In progress — refresh saved status.',
                  applied: 'Applied',
                  failed: 'Needs attention — review the error details.',
                  outcome_unknown:
                    'Blocked — outcome unresolved; operator review required. Do not retry automatically.',
                }[table.applyStatus.status]
              }
            </p>
          )}
          <details>
            <summary>Advanced details</summary>
            <p>
              {table.applyStatus && (
                <>
                  Recorded operation status: {table.applyStatus.status}.{' '}
                  {table.applyStatus.errorCode && (
                    <>Error: {table.applyStatus.errorCode}.</>
                  )}{' '}
                  Migration: {table.applyStatus.migrationId}.{' '}
                </>
              )}
              Saved draft revision {table.draftRevision} · Applied revision{' '}
              {table.appliedRevision ?? 'never'} · Physical revision {table.appliedPhysicalRevision ?? table.appliedRevision ?? 'never'}
            </p>
          </details>
          <p>
            Saved draft · Current database schema:{' '}
            {table.appliedRevision === null ? 'Not applied' : 'Applied'}
          </p>
          <p>
            Apply one index or requiredness change at a time. Existing nullable column/reference additions remain supported.
          </p>
          <button
            disabled={action.busy || f.formState.isDirty}
            onClick={() =>
              action.run(
                () => api<typeof preview>(path + '/preview', 'POST'),
                setPreview,
                'SQL preview ready',
              )
            }
          >
            Preview changes
          </button>
          {preview && (
            <section>
              <h2>
                {table.appliedRevision === null
                  ? 'Create table'
                  : preview.actions?.length ? 'Evolve' : 'Add safe columns to'}{' '}
                {table.name}
              </h2>
              {preview.actions?.map((operation, index) => <p key={index}>
                {operation.kind === 'set_not_null' ? `Make field required: ${operation.field}. All existing rows must already have a value.` : `${operation.kind === 'create_unique_index' ? 'Create unique index' : 'Create normal index'}: ${operation.fields?.join(', ')}.${operation.kind === 'create_unique_index' ? ' Existing duplicate values will block Apply.' : ''}`}
              </p>)}
              <ul>
                {table.fields
                  .filter(
                    (field) =>
                      table.appliedRevision === null || (!field.id || !applied.has(field.id)),
                  )
                  .map((field) => (
                    <li key={field.id}>
                      {field.name}:{' '}
                      {field.relationship ? 'Reference' : field.type}
                      {field.relationship && (
                        <p>
                          Reference to{' '}
                          {
                            preview.relationships?.find(
                              (r) => r.field === field.name,
                            )?.target
                          }
                          .id · {field.nullable ? 'Optional' : 'Required'} ·
                          Prevent deletion while referenced · Create
                          relationship index
                        </p>
                      )}
                      {field.nullable ? '' : ', required'}
                      {field.unique ? ', unique' : ''}
                      {field.default
                        ? `, default ${field.default.kind === 'current_timestamp' ? 'current timestamp' : JSON.stringify(field.default.value)}`
                        : ''}
                    </li>
                  ))}
              </ul>
              <p>
                Review this change before applying it to the connected database.
              </p>
              <details>
                <summary>Advanced details: generated SQL and revision</summary>
                <h3>Generated SQL · revision {preview.draftRevision}</h3>
                <pre>{preview.sql}</pre>
              </details>
              <p>
                Creates or changes this table in your connected PostgreSQL
                database.
              </p>
              <button
                disabled={
                  action.busy ||
                  f.formState.isDirty ||
                  preview.draftRevision !== table.draftRevision
                }
                onClick={() => {
                  if (
                    confirm(
                      'Reads and writes may be temporarily unavailable while this change runs. ' + (preview.actions?.some((operation) => operation.kind === 'create_unique_index') ? 'Existing duplicate values will block Apply.' : preview.actions?.some((operation) => operation.kind === 'set_not_null') ? 'All existing rows must already have a value.' : 'Review the preview before Apply.'),
                    )
                  )
                    void action.run(
                      () =>
                        api(path + '/apply', 'POST', {
                          expectedDraftRevision: preview.draftRevision,
                          planHash: preview.planHash,
                        }),
                      () => setPreview(null),
                      'Schema applied',
                    );
                }}
              >
                Apply schema
              </button>
            </section>
          )}
          {table.appliedRevision === null && (
            <button
              className="secondary"
              disabled={action.busy}
              onClick={() => {
                if (confirm('Delete this unapplied draft?'))
                  void action.run(
                    () => api(path, 'DELETE'),
                    () =>
                      window.location.assign(
                        path
                          .replace('schema/tables/', 'schema/')
                          .split('/schema/')[0]
                          .replace('projects/', '/projects/') + '/schema',
                      ),
                  );
              }}
            >
              Delete unapplied draft
            </button>
          )}
        </>
      )}
      <ActionState action={action} />
    </MutationBoundary>
  );
}
