'use client';
import {
  CredentialGuide,
  ApplicationLoginGuide,
} from '@/components/credential-guide';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { api, ApiError } from '@/lib/api';
import type { Auth, Endpoint } from '@/lib/contracts';
import {
  useData,
  useAction,
  ActionState,
  ErrorBox,
  DirtyGuard,
} from '@/components/ui';
const statusLabels: Record<string, string> = {
  unprovisioned: 'Configured — create authentication tables',
  provisioning: 'Creating authentication tables',
  ready: 'Ready',
  failed: 'Failed — review the error and retry explicitly',
  outcome_unknown: 'Review required — do not retry automatically',
};
function Editor({
  path,
  data,
  protectedPolicies,
}: {
  path: string;
  data?: Auth;
  protectedPolicies: boolean;
}) {
  const action = useAction({
    refresh: [path],
    success: 'Authentication configuration saved',
  });
  const [revision, setRevision] = useState(data?.revision ?? 0);
  const f = useForm({
    defaultValues: {
      enabled: data?.enabled ?? false,
      signupEnabled: data?.signupEnabled ?? false,
      sessionLifetimeSeconds: data?.sessionLifetimeSeconds ?? 86400,
    },
  });
  useEffect(() => {
    if (data && !f.formState.isDirty && !action.busy) {
      setRevision(data.revision);
      f.reset({
        enabled: data.enabled,
        signupEnabled: data.signupEnabled,
        sessionLifetimeSeconds: data.sessionLifetimeSeconds,
      });
    }
  }, [data?.revision, action.busy, f.formState.isDirty]);
  async function save() {
    let success = false;
    await f.handleSubmit(async (v) => {
      if (
        data?.enabled &&
        !v.enabled &&
        !confirm(
          'Application login and protected API access will stop working. Continue?',
        )
      )
        return;
      const result = await action.run(() =>
        api<Auth>(path, 'PUT', { ...v, expectedRevision: revision }),
      );
      if (result) {
        setRevision(result.revision);
        f.reset({
          enabled: result.enabled,
          signupEnabled: result.signupEnabled,
          sessionLifetimeSeconds: result.sessionLifetimeSeconds,
        });
        success = true;
      }
    })();
    return success;
  }
  return (
    <>
      <DirtyGuard
        dirty={f.formState.isDirty}
        save={save}
        discard={() => f.reset()}
      />
      <ol>
        <li>Enable application login</li>
        <li>Optionally allow signup</li>
        <li>Save configuration</li>
        <li>Create authentication tables</li>
        <li>Choose endpoint access</li>
        <li>Test signup/login in Playground</li>
      </ol>
      <p role="status">
        Authentication status:{' '}
        {data
          ? (statusLabels[data.provisioningStatus] ?? data.provisioningStatus)
          : 'Not configured'}{' '}
        · {data?.enabled ? 'Enabled' : 'Disabled'}
        {data?.blocked
          ? ' · Schema operation pending or operator review required'
          : ''}
      </p>
      <details>
        <summary>Advanced details</summary>
        <p>
          Configuration revision: {data?.revision ?? 0}. Recorded status:{' '}
          {data?.provisioningStatus ?? 'Not configured'}.
        </p>
      </details>
      {data?.revision !== undefined &&
        data.revision !== revision &&
        f.formState.isDirty && (
          <p className="warning">
            Server revision changed. Your input is preserved; reload and review
            before saving.
          </p>
        )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="check">
          <input type="checkbox" {...f.register('enabled')} />
          Enable application login
        </label>
        <label className="check">
          <input type="checkbox" {...f.register('signupEnabled')} />
          Allow signup (optional)
        </label>
        <label>
          Session lifetime (seconds)
          <input
            type="number"
            min={300}
            max={604800}
            {...f.register('sessionLifetimeSeconds', { valueAsNumber: true })}
            required
          />
        </label>
        <button disabled={action.busy}>Save auth configuration</button>
        <button type="button" className="secondary" onClick={() => f.reset()}>
          Discard edits
        </button>
      </form>
      <button
        disabled={
          action.busy ||
          f.formState.isDirty ||
          !data ||
          ['ready', 'provisioning', 'outcome_unknown'].includes(
            data.provisioningStatus,
          )
        }
        onClick={() => {
          if (
            confirm(
              'Create authentication tables in the connected customer database?',
            )
          )
            void action.run(
              () =>
                api(path + '/provision', 'POST', {
                  expectedRevision: data!.revision,
                }),
              undefined,
              'Authentication tables created',
            );
        }}
      >
        Create authentication tables
      </button>
      <ActionState action={action} />
    </>
  );
}
export default function AuthPage() {
  const { id } = useParams<{ id: string }>();
  const path = `projects/${id}/auth`;
  const q = useData<Auth>(path);
  const endpoints = useData<Endpoint[]>(`projects/${id}/endpoints`);
  const [reload, setReload] = useState(0);
  const missing = q.error instanceof ApiError && q.error.status === 404;
  return (
    <>
      <h1>Application authentication</h1>
      <p>Add application signup/login when your API needs signed-in users.</p>
      <CredentialGuide />
      <ApplicationLoginGuide />
      <p>
        Application-user authentication is separate from platform-user dashboard
        access. This MVP has no email verification or password reset.
      </p>
      <button className="secondary" onClick={() => void q.refetch()}>
        Refresh status (keep edits)
      </button>
      <button
        className="secondary"
        onClick={async () => {
          if (confirm('Discard edits and reload saved auth configuration?')) {
            await q.refetch();
            setReload((n) => n + 1);
          }
        }}
      >
        Reload saved data
      </button>
      {q.isPending ? (
        <p>Loading authentication status…</p>
      ) : q.data || missing ? (
        <Editor
          key={reload}
          path={path}
          data={q.data}
          protectedPolicies={
            !!endpoints.data?.some((e) =>
              Object.values(e.policies ?? {}).some(
                (p) => p?.mode !== 'key_only',
              ),
            )
          }
        />
      ) : (
        <ErrorBox error={q.error} />
      )}
      <p>
        <Link href={`/projects/${id}/apis`}>Choose endpoint access</Link> ·{' '}
        <Link href={`/projects/${id}/playground`}>Test signup/login</Link>
      </p>
      <details>
        <summary>Advanced: test user role administration</summary>
        <h2>Test user role</h2>
        <p>
          Use a known application-user UUID from the playground. Role changes
          affect existing sessions. Admin bypass is controlled separately for
          each operation.
        </p>
        <Role path={path} />
      </details>
    </>
  );
}
function Role({ path }: { path: string }) {
  const action = useAction({ success: 'Application user role updated' });
  const f = useForm<{ userId: string; role: string }>({
    defaultValues: { role: 'user' },
  });
  return (
    <>
      <DirtyGuard dirty={f.formState.isDirty} />
      <form
        onSubmit={f.handleSubmit(async (v) => {
          if (
            confirm(
              `Change this application user to ${v.role}? This changes permissions for existing sessions.`,
            )
          ) {
            const result = await action.run(() =>
              api(`${path}/users/${v.userId}/role`, 'PATCH', { role: v.role }),
            );
            if (result) f.reset(v);
          }
        })}
      >
        <label>
          User UUID
          <input {...f.register('userId')} required pattern="[a-f0-9-]{36}" />
        </label>
        <label>
          Role
          <select {...f.register('role')}>
            <option>user</option>
            <option>admin</option>
          </select>
        </label>
        <button disabled={action.busy}>Set role</button>
        <ActionState action={action} />
      </form>
    </>
  );
}
