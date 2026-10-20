'use client';
import { useForm } from 'react-hook-form';
import type { Connection } from '@/lib/contracts';
import { api } from '@/lib/api';
import { useAction, ActionState, DirtyGuard, MutationBoundary } from './ui';
export function CredentialUpdate({
  connection,
  path,
}: {
  connection: Connection;
  path: string;
}) {
  const action = useAction({
    refresh: [path],
    success: 'Database credentials updated; saved connection refreshed',
  });
  const f = useForm({
    defaultValues: {
      username: '',
      password: '',
      ssl: connection.identity?.ssl ?? true,
    },
  });
  const target = connection.identity;
  return (
    <MutationBoundary busy={action.busy}>
      <section>
        <h2>Update database credentials</h2>
        <p>
          This changes the credentials used to connect to the same database. It
          does not move the project to another database.
        </p>
        <p>
          Immutable target: Host {target?.host} · Port {target?.port} · Database{' '}
          {target?.database} · Schema {target?.schema}
        </p>
        <p>
          Candidate credentials are checked without changing customer data. If
          validation fails, the saved credentials remain unchanged.
        </p>
        <DirtyGuard dirty={f.formState.isDirty} />
        <form
          autoComplete="off"
          onSubmit={f.handleSubmit(async (values) => {
            try {
              const result = await action.run(() =>
                api(path + '/credentials', 'PUT', {
                  ...values,
                  expectedRevision: connection.revision ?? 1,
                }),
              );
              if (result)
                f.reset({
                  username: values.username,
                  password: '',
                  ssl: values.ssl,
                });
            } finally {
              f.setValue('password', '');
            }
          })}
        >
          <label>
            New database username
            <input {...f.register('username')} required autoComplete="off" />
          </label>
          <label>
            New database password
            <input
              {...f.register('password')}
              type="password"
              required
              autoComplete="new-password"
            />
          </label>
          <label className="check">
            <input type="checkbox" {...f.register('ssl')} />
            Use verified TLS
          </label>
          <button>Test and update credentials</button>
        </form>
        <ActionState action={action} />
      </section>
    </MutationBoundary>
  );
}
