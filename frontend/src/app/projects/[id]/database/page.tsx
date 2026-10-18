'use client';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import type { Connection } from '@/lib/contracts';
import {
  useData,
  useAction,
  ActionState,
  ErrorBox,
  DirtyGuard,
} from '@/components/ui';
const schema = z.object({
  label: z.string().trim().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  schema: z.string().min(1),
  ssl: z.boolean(),
});
type Input = z.infer<typeof schema>;
export default function Database() {
  const { id } = useParams<{ id: string }>();
  const path = `projects/${id}/database-connection`;
  const q = useData<Connection>(path);
  const action = useAction({
    refresh: [path],
    success: 'Connection check passed',
    failure: 'Connection check failed; saved status refreshed',
  });
  const { register, handleSubmit, setValue, reset, formState } = useForm<Input>(
    {
      defaultValues: {
        label: 'PostgreSQL',
        port: 5432,
        schema: 'public',
        ssl: true,
      },
    },
  );
  const absent = q.error instanceof ApiError && q.error.status === 404;
  return (
    <>
      <h1>Database connection</h1>
      <DirtyGuard dirty={formState.isDirty} />
      <p>
        A connection check verifies connectivity and schema existence. It does
        not guarantee future table creation or CRUD privileges.
      </p>
      {q.isPending ? (
        <p>Loading…</p>
      ) : q.data ? (
        <section>
          <h2>{q.data.label}</h2>
          {q.data.identity && (
            <p>
              {q.data.identity.username}@{q.data.identity.host}:
              {q.data.identity.port}/{q.data.identity.database} · schema{' '}
              {q.data.identity.schema} ·{' '}
              {q.data.identity.ssl
                ? 'Encrypted TLS'
                : 'Unencrypted DB transport'}
            </p>
          )}
          {q.data.replacement && !q.data.replacement.eligible && (
            <p className="warning">
              Replacement blocked by: {q.data.replacement.blockers.join(', ')}.
              Applied schemas cannot be rebound in this MVP.
            </p>
          )}
          <p>
            Last connection check: {q.data.lastTestStatus} ·{' '}
            {q.data.lastTestedAt ?? 'Never'}
          </p>
          <button
            disabled={action.busy}
            onClick={() => action.run(() => api(path + '/test', 'POST'))}
          >
            Retest saved connection
          </button>
        </section>
      ) : absent ? (
        <p>
          No database connected. Connect a disposable PostgreSQL database below.
        </p>
      ) : (
        <ErrorBox error={q.error} />
      )}
      <section>
        <h2>{q.data ? 'Replace connection' : 'Connect PostgreSQL'}</h2>
        <p>
          Saving tests the connection first. Replacement requires all settings
          again. Saved credentials are never returned.
        </p>
        <form
          autoComplete="off"
          onSubmit={handleSubmit(async (values) => {
            try {
              const saved = await action.run(() =>
                api(path, q.data ? 'PUT' : 'POST', schema.parse(values)),
              );
              if (saved) {
                reset({ ...values, password: '' });
                action.setMessage(
                  q.data ? 'Connection replaced' : 'Connection saved',
                );
              }
            } finally {
              setValue('password', '');
            }
          })}
        >
          <div className="row">
            {(['label', 'host', 'database', 'username', 'schema'] as const).map(
              (name) => (
                <label key={name}>
                  {name[0].toUpperCase() + name.slice(1)}
                  <input {...register(name)} required autoComplete="off" />
                </label>
              ),
            )}
            <label>
              Port
              <input
                type="number"
                {...register('port', { valueAsNumber: true })}
                required
                min={1}
                max={65535}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                {...register('password')}
                required
                autoComplete="new-password"
              />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" {...register('ssl')} />
            Use SSL with certificate verification
          </label>
          <p>Disabling SSL means the database transport is unencrypted.</p>
          <button
            disabled={
              action.busy ||
              q.isPending ||
              (!q.data && !absent) ||
              q.data?.replacement?.eligible === false
            }
          >
            {q.data ? 'Test and replace' : 'Test and save'}
          </button>
        </form>
      </section>
      <ActionState action={action} />
    </>
  );
}
