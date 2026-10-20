'use client';
import type { Field, ManagedIndex } from '@/lib/contracts';
import { indexableTypes } from '@/lib/schema-indexes';
export function Indexes({ indexes, fields, applied, appliedFieldIds, busy, attention, onChange }: {
  indexes: ManagedIndex[]; fields: Field[]; applied: ManagedIndex[]; appliedFieldIds?: Set<string> | undefined;
  busy: boolean; attention: boolean; onChange: (indexes: ManagedIndex[]) => void;
}) {
  const eligible = fields.filter((field) => field.id && indexableTypes.has(field.type) && (!appliedFieldIds || appliedFieldIds.has(field.id)));
  const edit = (position: number, index: ManagedIndex) => onChange(indexes.map((item, i) => i === position ? index : item));
  return <section aria-label="Indexes"><h2>Indexes</h2>
    <p>UUID, integer, bigint, boolean, decimal and timestamp fields are eligible. Save new fields before choosing them. Indexes use ascending B-tree order. Maximum eight user indexes, each with one to four fields.</p>
    <p>Unique indexes allow multiple NULL values. For composite uniqueness, keys containing NULL follow PostgreSQL distinct-null semantics. Uniqueness is table-wide unless an ownership field is explicitly included.</p>
    <h3>User indexes</h3>
    {attention && <p role="status">Latest Apply needs attention. Applied indexes remain locked; review operation details.</p>}
    {indexes.map((index, position) => {
      const locked = !!index.id && applied.some((candidate) => candidate.id === index.id);
      return <fieldset key={index.id ?? position} disabled={busy || locked}><legend>Index {position + 1} · {locked ? 'Applied' : 'Draft'}</legend>
        <label><input type="checkbox" checked={index.unique} onChange={(event) => edit(position, { ...index, unique: event.target.checked })} />Unique index {position + 1}</label>
        {index.fieldIds.map((id, keyPosition) => <div key={keyPosition}>
          <label>Index {position + 1} field {keyPosition + 1}<select required value={id} onChange={(event) => edit(position, { ...index, fieldIds: index.fieldIds.map((value, j) => j === keyPosition ? event.target.value : value) })}>
            <option value="">Choose eligible field</option>{eligible.filter((field) => !index.unique || !field.relationship).map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>
          <button type="button" aria-label={`Move index ${position + 1} field ${keyPosition + 1} up`} disabled={keyPosition === 0} onClick={() => {
            const reordered = [...index.fieldIds]; [reordered[keyPosition - 1], reordered[keyPosition]] = [reordered[keyPosition]!, reordered[keyPosition - 1]!]; edit(position, { ...index, fieldIds: reordered });
          }}>Move up</button>
          <button type="button" onClick={() => edit(position, { ...index, fieldIds: index.fieldIds.filter((_, j) => j !== keyPosition) })}>Remove field {keyPosition + 1}</button>
        </div>)}
        <button type="button" disabled={index.fieldIds.length >= 4} onClick={() => edit(position, { ...index, fieldIds: [...index.fieldIds, ''] })}>Add index field</button>
        <button type="button" onClick={() => onChange(indexes.filter((_, i) => i !== position))}>Remove draft index {position + 1}</button>
      </fieldset>;
    })}
    <button type="button" disabled={busy || indexes.length >= 8 || !eligible.length} onClick={() => onChange([...indexes, { fieldIds: [''], unique: false }])}>Add index</button>
    <h3>Relationship indexes · system managed</h3>
    {fields.filter((field) => field.relationship).map((field) => <p key={field.id}>{field.name} · automatic relationship index · read-only</p>)}
  </section>;
}
