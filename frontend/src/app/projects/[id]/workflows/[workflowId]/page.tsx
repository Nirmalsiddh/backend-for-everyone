'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { api } from '@/lib/api';
import type {
  Workflow,
  Definition,
  Table,
  InputField,
  Preview,
} from '@/lib/contracts';
import { counts } from '@/lib/workflow';
import {
  useData,
  useAction,
  ActionState,
  State,
  Json,
  DirtyGuard,
} from '@/components/ui';
import { InputsEditor } from '@/features/workflows/inputs';
import { CapabilitySummary } from '@/features/workflows/lifecycle';
import { useEffect } from 'react';
import { reconcileAuth } from '@/lib/workflow';
import { Steps } from '@/features/workflows/steps';
function Editor({
  path,
  workflow,
  tables,
}: {
  path: string;
  workflow: Workflow;
  tables: Table[];
}) {
  const action = useAction({
    refresh: [path, path.split('/workflows/')[0] + '/workflows'],
    success: 'Workflow state updated',
  });
  const [draftRevision, setDraftRevision] = useState(workflow.draftRevision);
  const [saved, setSaved] = useState(workflow);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [publishedDefinition, setPublishedDefinition] = useState<string | null>(
    workflow.publishedDefinition
      ? JSON.stringify(workflow.publishedDefinition)
      : null,
  );

  const f = useForm<{ definition: Definition }>({
    defaultValues: { definition: workflow.draftDefinition },
  });
  const def = f.watch('definition');
  const c = counts(def.steps);
  const exceeds = c.steps > 30 || c.db > 10 || c.tables.size > 5 || c.depth > 3;
  useEffect(() => {
    setSaved(workflow);
    if (!f.formState.isDirty) {
      f.reset({ definition: workflow.draftDefinition });
      setDraftRevision(workflow.draftRevision);
    }
    setPublishedDefinition(
      workflow.publishedDefinition
        ? JSON.stringify(workflow.publishedDefinition)
        : null,
    );
  }, [workflow]);
  async function saveValues(v: { definition: Definition }) {
    return action.run(async () => {
      if (exceeds) throw new Error('Workflow exceeds limits');
      const w = await api<Workflow>(path + '/draft', 'PUT', {
        expectedDraftRevision: draftRevision,
        definition: v.definition,
      });
      setSaved(w);
      setDraftRevision(w.draftRevision);
      f.reset({ definition: w.draftDefinition });
      setPreview(null);
      return w;
    });
  }
  async function saveForNavigation() {
    let success = false;
    await f.handleSubmit(async (v) => {
      success = !!(await saveValues(v));
    })();
    return success;
  }
  return (
    <>
      <DirtyGuard
        dirty={f.formState.isDirty}
        save={saveForNavigation}
        discard={() => f.reset()}
      />
      {draftRevision !== workflow.draftRevision && f.formState.isDirty && (
        <p className="warning">
          Server draft revision changed. Your edits are preserved; reload and
          review before saving.
        </p>
      )}
      {workflow.readiness && (
        <p role="status">
          Publication readiness: {workflow.readiness.state}.{' '}
          {workflow.readiness.reasons.join('. ')}
        </p>
      )}
      <p>
        POST /{workflow.path} · Saved draft revision {saved.draftRevision} ·{' '}
        {saved.enabled ? 'Enabled' : 'Disabled'}
      </p>
      <p>
        {!saved.publishedVersionId
          ? 'Unpublished'
          : publishedDefinition === JSON.stringify(def)
            ? 'Draft matches published version'
            : publishedDefinition
              ? 'Draft differs from published version'
              : 'Published definition unavailable; reload saved data'}
      </p>
      <p>
        {c.steps}/30 steps · {c.db}/10 DB operations · {c.tables.size}/5 tables
        · condition depth {c.depth}/3
      </p>
      {exceeds && <p role="alert">Workflow exceeds backend limits.</p>}
      <form onSubmit={f.handleSubmit(saveValues)}>
        <label>
          Workflow auth
          <Controller
            control={f.control}
            name="definition.auth"
            render={({ field }) => (
              <select
                value={field.value}
                onChange={(e) => {
                  if (
                    confirm(
                      'Changing workflow authentication updates incompatible database-step policies. Review references and ownership before publishing.',
                    )
                  ) {
                    field.onChange(e.target.value);
                    f.setValue(
                      'definition.steps',
                      reconcileAuth(
                        def.steps,
                        e.target.value as Definition['auth'],
                      ),
                      { shouldDirty: true },
                    );
                    setPreview(null);
                  }
                }}
              >
                <option value="key_only">API key required</option>
                <option value="authenticated">Signed-in user required</option>
              </select>
            )}
          />
        </label>
        <p>Database-step policies must match workflow authentication.</p>
        <InputsEditor
          input={def.input}
          onChange={(input) => {
            f.setValue('definition.input', input, { shouldDirty: true });
            setPreview(null);
          }}
        />
        <h2>Sequential steps</h2>
        <p>
          Responses with error status roll back previous database writes in this
          workflow.
        </p>
        <p className="warning">
          Workflow permissions are independent of generic CRUD permissions.
          Review each database step’s access.
        </p>
        <Controller
          control={f.control}
          name="definition.steps"
          render={({ field }) => (
            <Steps
              steps={field.value}
              onChange={(v) => {
                field.onChange(v);
                setPreview(null);
              }}
              def={def}
              tables={tables}
            />
          )}
        />
        <button disabled={action.busy || exceeds}>Save workflow draft</button>
      </form>
      <button
        disabled={action.busy || f.formState.isDirty}
        onClick={() =>
          action.run(() => api<Preview>(path + '/preview', 'POST'), setPreview)
        }
      >
        Preview workflow
      </button>
      {preview && (
        <section>
          <h2>Publication preview</h2>
          <CapabilitySummary
            workflow={saved}
            definition={def}
            preview={preview}
            tables={tables}
          />
          <button
            disabled={action.busy || f.formState.isDirty}
            onClick={() =>
              action.run(async () => {
                if (
                  saved.enabled &&
                  !confirm(
                    'This immediately replaces the workflow handling live requests. Continue?',
                  )
                )
                  return;
                await api(path + '/publish', 'POST', {
                  expectedDraftRevision: preview.draftRevision,
                  definitionHash: preview.definitionHash,
                });
                const w = await api<Workflow>(path);
                setSaved(w);
                setPublishedDefinition(
                  JSON.stringify(w.publishedDefinition ?? w.draftDefinition),
                );
                setPreview(null);
              })
            }
          >
            Publish workflow
          </button>
        </section>
      )}
      <button
        disabled={action.busy || !saved.publishedVersionId}
        onClick={() => {
          if (
            saved.enabled &&
            !confirm(
              'Calls to this workflow will stop succeeding. Disable workflow?',
            )
          )
            return;
          return action.run(
            () =>
              api<Workflow>(path, 'PATCH', {
                expectedDraftRevision: saved.draftRevision,
                enabled: !saved.enabled,
              }),
            setSaved,
          );
        }}
      >
        {saved.enabled ? 'Disable workflow' : 'Enable workflow'}
      </button>
      <details>
        <summary>Read-only definition JSON</summary>
        <Json value={def} />
      </details>
      <ActionState action={action} />
    </>
  );
}
export default function WorkflowPage() {
  const { id, workflowId } = useParams<{ id: string; workflowId: string }>();
  const path = `projects/${id}/workflows/${workflowId}`;
  const q = useData<Workflow>(path);
  const t = useData<Table[]>(`projects/${id}/schema`);
  const [reload, setReload] = useState(0);
  return (
    <>
      <h1>Workflow editor</h1>
      <button
        className="secondary"
        onClick={async () => {
          if (
            confirm('Reload saved definition? Unsaved edits will be discarded.')
          ) {
            await q.refetch();
            setReload((n) => n + 1);
          }
        }}
      >
        Reload saved data
      </button>
      <State query={q}>
        <State query={t}>
          {q.data && t.data && (
            <Editor
              key={workflowId + '-' + reload}
              path={path}
              workflow={q.data}
              tables={t.data.filter((t) => t.appliedRevision !== null)}
            />
          )}
        </State>
      </State>
    </>
  );
}
