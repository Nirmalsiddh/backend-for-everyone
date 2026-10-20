'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { api } from '@/lib/api';
import type { Workflow } from '@/lib/contracts';
import { newStep } from '@/lib/workflow';
import {
  useData,
  useAction,
  ActionState,
  State,
  DirtyGuard,
  MutationBoundary,
} from '@/components/ui';
export default function Workflows() {
  const { id } = useParams<{ id: string }>();
  const path = `projects/${id}/workflows`;
  const q = useData<Workflow[]>(path);
  const action = useAction({ refresh: [path], success: 'Workflow created' });
  const router = useRouter();
  const f = useForm<{ path: string }>();
  return (
    <>
      <h1>Workflows</h1>
      <p>
        Optional: combine multiple database actions and business rules into one
        request.
      </p>
      <p>
        Use workflows when one API request needs multiple database actions or
        business rules.
      </p>
      <State query={q}>
        {q.data?.length === 0 && (
          <p>No workflows. Create your first workflow below.</p>
        )}
        {q.data?.map((w) => (
          <section key={w.id}>
            <Link href={`/projects/${id}/workflows/${w.id}`}>
              POST /{w.path}
            </Link>{' '}
            · {w.publishedVersionId ? 'Published' : 'Unpublished'} ·{' '}
            {w.enabled ? 'Enabled' : 'Disabled'} ·{' '}
            {w.readiness?.state === 'blocked'
              ? w.readiness.reasons.join('. ')
              : 'Dependency status checked'}
          </section>
        ))}
      </State>
      <MutationBoundary busy={action.busy}>
        <section>
          <h2>Create POST workflow</h2>
          <DirtyGuard dirty={f.formState.isDirty} />
          <form
            onSubmit={f.handleSubmit((v) =>
              action.run(
                () =>
                  api<Workflow>(path, 'POST', {
                    path: v.path,
                    definition: {
                      input: {},
                      auth: 'key_only',
                      steps: [newStep('response', 'respond', 'key_only')],
                    },
                  }),
                (w) => {
                  f.reset();
                  router.push(`/projects/${id}/workflows/${w.id}`);
                },
              ),
            )}
          >
            <label>
              Path slug
              <input
                required
                pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
                maxLength={63}
                {...f.register('path')}
              />
            </label>
            <button disabled={action.busy}>Create workflow</button>
          </form>
          <ActionState action={action} />
        </section>
      </MutationBoundary>
    </>
  );
}
