'use client';
import type { Field, Policy } from '@/lib/contracts';
export function PolicyEditor({
  value,
  onChange,
  fields,
  authMode,
}: {
  value: Policy;
  onChange: (p: Policy) => void;
  fields: Field[];
  authMode?: 'key_only' | 'authenticated';
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
          ? 'Requires an API key. Application sessions are not accepted.'
          : value.mode === 'authenticated'
            ? 'Signed-in users may access rows without ownership filtering.'
            : 'Row access is restricted by the selected UUID ownership field. Creates assign the current user automatically.'}
      </p>
      {value.mode === 'owner' && (
        <>
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
