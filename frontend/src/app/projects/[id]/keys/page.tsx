'use client';
import { CredentialGuide } from '@/components/credential-guide';
import { SecretDialog } from '@/components/secret-dialog';
import { DirtyGuard } from '@/components/ui';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { api } from '@/lib/api';
import type { KeyMetadata } from '@/lib/contracts';
import { useData, useAction, ActionState, State } from '@/components/ui';
export default function Keys() {
  const { id } = useParams<{ id: string }>();
  const path = `projects/${id}/api-keys`;
  const q = useData<KeyMetadata[]>(path);
  const action = useAction({
    refresh: [path],
    success: 'API key metadata refreshed',
  });
  const [secret, setSecret] = useState('');
  const { register, handleSubmit, reset, formState } = useForm<{
    name: string;
    scope: string;
  }>({ defaultValues: { scope: 'read' } });
  return (
    <>
      <h1>API keys</h1>
      <CredentialGuide />
      <p>API keys are project-scoped secrets.</p>
      <p>
        Keep API keys in trusted server code. Browser and mobile application
        bundles cannot keep embedded API keys secret.
      </p>
      <DirtyGuard dirty={formState.isDirty} />
      <form
        onSubmit={handleSubmit((v) =>
          action.run(
            () => api<{ key: string }>(path, 'POST', v),
            (d) => {
              setSecret(d.key);
              reset();
            },
            'API key generated; copy it now',
          ),
        )}
      >
        <label>
          Name
          <input {...register('name')} required maxLength={100} />
        </label>
        <label>
          Scope
          <select {...register('scope')}>
            <option value="read">Read only</option>
            <option value="read_write">Read and write</option>
          </select>
        </label>
        <button disabled={action.busy || !!secret}>Generate key</button>
      </form>
      {secret && <SecretDialog secret={secret} onClose={() => setSecret('')} />}
      <ActionState action={action} />
      <State query={q}>
        {q.data?.length === 0 ? (
          <p>
            Create a key only for API-key-protected operations. Signed-in-user
            APIs do not need one.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scope</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>{k.keyPrefix}</td>
                  <td>{k.scope === 'read' ? 'Read only' : 'Read and write'}</td>
                  <td>{k.revokedAt ? 'Revoked' : 'Active'}</td>
                  <td>
                    <button
                      disabled={!!k.revokedAt || action.busy}
                      onClick={() => {
                        if (
                          confirm(
                            'Applications using this key will immediately lose access. Revoke key?',
                          )
                        )
                          void action.run(
                            () => api(path + '/' + k.id, 'DELETE'),
                            undefined,
                            'API key revoked',
                          );
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </State>
    </>
  );
}
