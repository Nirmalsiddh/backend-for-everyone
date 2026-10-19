'use client';
import Link from 'next/link';
import { ownershipWarning } from '@/lib/schema-form';
import type { Field, Policy } from '@/lib/contracts';
export function PolicyEditor({
  value,
  onChange,
  fields,
  authMode,
  authReady,
  authHref,
}: {
  value: Policy;
  onChange: (p: Policy) => void;
  fields: Field[];
  authMode?: 'key_only' | 'authenticated';
  authReady?: boolean;
  authHref?: string;
}) {
  return (
    <>
      <label>
        Policy
        <select
          value={value.mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'owner'
                ? {
                    mode: 'owner',
                    ownerFieldId: '',
                    allowAdmin: false,
                  }
                : { mode: e.target.value as 'key_only' | 'authenticated' },
            )
          }
        >
          {(!authMode || authMode === 'key_only') && (
            <option value="key_only">API key required</option>
          )}
          {(!authMode || authMode === 'authenticated') && (
            <>
              <option value="authenticated">Signed-in user required</option>
              <option value="owner">Record owner only</option>
            </>
          )}
        </select>
      </label>
      <p className="muted">
        {value.mode === 'key_only'
          ? 'Use a project API key. Application login tokens are not accepted.'
          : value.mode === 'authenticated'
            ? 'Any signed-in application user can access this operation.'
            : 'Users can access rows where the ownership field matches their application account. Ownership is assigned automatically for create. For update, clients cannot transfer ownership.'}
      </p>
      {value.mode !== 'key_only' && authReady === false && (
        <p role="note" className="warning">
          This access mode requires application authentication. Set up
          authentication before this operation can be enabled.{' '}
          <Link href={authHref ?? '#'}>Set up application authentication</Link>
        </p>
      )}
      {value.mode === 'owner' && (
        <>
          <p role="note">{ownershipWarning}</p>
          {value.allowAdmin && (
            <p>Application admins can access all rows for this operation.</p>
          )}
          <label>
            Owner field
            <select
              required
              value={value.ownerFieldId ?? ''}
              onChange={(e) =>
                onChange({ ...value, ownerFieldId: e.target.value })
              }
            >
              <option value="">Choose applied UUID field</option>
              {fields
                .filter((f) => f.type === 'uuid')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={value.allowAdmin ?? false}
              onChange={(e) =>
                onChange({ ...value, allowAdmin: e.target.checked })
              }
            />
            Allow application admins to access all rows
          </label>
        </>
      )}
    </>
  );
}
