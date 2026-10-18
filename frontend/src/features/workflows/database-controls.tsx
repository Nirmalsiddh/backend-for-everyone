'use client';
import { useRef } from 'react';
import type { Definition, Step, Table } from '@/lib/contracts';
import type { ReferenceOption } from '@/lib/workflow';
import { newStep } from '@/lib/workflow';
import { PolicyEditor } from '@/features/apis/policy';
import { ValueEditor } from './value-editor';
export function DatabaseControls({
  step,
  update,
  index,
  def,
  tables,
  refs,
}: {
  step: Step;
  update: (index: number, step: Step) => void;
  index: number;
  def: Definition;
  tables: Table[];
  refs: ReferenceOption[];
}) {
  const table =
    'tableId' in step ? tables.find((t) => t.id === step.tableId) : undefined;
  const fields = table?.appliedDefinition?.definition.fields ?? [];
  const fieldOptions = [{ id: 'id', name: 'id' }, ...fields];
  const keys = useRef<string[]>([]);
  const counter = useRef(0);
  if (step.type === 'update')
    while (keys.current.length < step.assignments.length)
      keys.current.push(`assignment_${counter.current++}`);
  return (
    <>
      {' '}
      {'tableId' in step && (
        <>
          <label>
            Managed table
            <select
              value={step.tableId}
              onChange={(e) => {
                if (
                  step.tableId &&
                  !confirm(
                    'Changing table resets the step mappings, output selection, and policy. Continue?',
                  )
                )
                  return;
                const fresh = newStep(step.type, step.name, def.auth);
                if ('tableId' in fresh)
                  update(index, {
                    ...fresh,
                    id: step.id,
                    tableId: e.target.value,
                  });
              }}
            >
              <option value="">Choose applied table</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <PolicyEditor
            value={step.access}
            onChange={(access) => update(index, { ...step, access })}
            fields={fields}
            authMode={def.auth}
          />
        </>
      )}
      {'select' in step && (
        <fieldset>
          <legend>Return selected fields</legend>
          {fieldOptions.map((f) => (
            <label className="check" key={f.id}>
              <input
                type="checkbox"
                checked={step.select.includes(f.id!)}
                onChange={(e) =>
                  update(index, {
                    ...step,
                    select: e.target.checked
                      ? [...step.select, f.id!]
                      : step.select.filter((id) => id !== f.id),
                  })
                }
              />
              {f.name}
            </label>
          ))}
        </fieldset>
      )}
      {'idValue' in step && (
        <ValueEditor
          key={step.tableId}
          label="Record ID"
          value={step.idValue}
          refs={refs}
          onChange={(idValue) => update(index, { ...step, idValue })}
        />
      )}
      {step.type === 'query' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={step.forUpdate ?? false}
              onChange={(e) =>
                update(index, { ...step, forUpdate: e.target.checked })
              }
            />
            Lock row for update
          </label>
          <label>
            When missing
            <select
              value={step.onMissing}
              onChange={(e) =>
                update(index, {
                  ...step,
                  onMissing: e.target.value as '404' | 'null',
                })
              }
            >
              <option value="404">404</option>
              <option value="null">Return null</option>
            </select>
          </label>
        </>
      )}
      {step.type === 'insert' && (
        <>
          {fields
            .filter((f) => f.id !== step.access.ownerFieldId)
            .map((f) => (
              <div key={f.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Object.hasOwn(step.values, f.id!)}
                    onChange={(e) =>
                      update(index, {
                        ...step,
                        values: e.target.checked
                          ? {
                              ...step.values,
                              [f.id!]: { kind: 'literal', value: '' },
                            }
                          : Object.fromEntries(
                              Object.entries(step.values).filter(
                                ([k]) => k !== f.id,
                              ),
                            ),
                      })
                    }
                  />
                  Set {f.name}
                  {!f.nullable && !f.default ? ' (required)' : ''}
                </label>
                {step.values[f.id!] && (
                  <ValueEditor
                    label={f.name}
                    value={step.values[f.id!]}
                    refs={refs}
                    onChange={(value) =>
                      update(index, {
                        ...step,
                        values: { ...step.values, [f.id!]: value },
                      })
                    }
                  />
                )}
              </div>
            ))}
        </>
      )}
      {step.type === 'update' && (
        <>
          <label>
            On no match
            <select
              value={step.onNoMatch}
              onChange={(e) =>
                update(index, {
                  ...step,
                  onNoMatch: Number(e.target.value) as 404 | 409 | 422,
                })
              }
            >
              {[404, 409, 422].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          {step.assignments.map((assignment, i) => (
            <div className="card" key={keys.current[i]}>
              <label>
                Assignment field
                <select
                  value={assignment.fieldId}
                  onChange={(e) =>
                    update(index, {
                      ...step,
                      assignments: step.assignments.map((a, n) =>
                        n === i ? { ...a, fieldId: e.target.value } : a,
                      ),
                    })
                  }
                >
                  <option value="">Choose field</option>
                  {fields
                    .filter((f) => f.id !== step.access.ownerFieldId)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Operation
                <select
                  value={assignment.operation}
                  onChange={(e) =>
                    update(index, {
                      ...step,
                      assignments: step.assignments.map((a, n) =>
                        n === i
                          ? {
                              fieldId: a.fieldId,
                              value: a.value,
                              operation: e.target.value as 'set' | 'decrement',
                              ...(e.target.value === 'decrement'
                                ? { guard: 'gte_value' as const }
                                : {}),
                            }
                          : a,
                      ),
                    })
                  }
                >
                  <option value="set">Set</option>
                  <option
                    value="decrement"
                    disabled={
                      fields.find((f) => f.id === assignment.fieldId)?.type !==
                      'integer'
                    }
                  >
                    Guarded decrement (integer only)
                  </option>
                </select>
              </label>
              <ValueEditor
                label="Assignment"
                value={assignment.value}
                refs={refs}
                onChange={(value) =>
                  update(index, {
                    ...step,
                    assignments: step.assignments.map((a, n) =>
                      n === i ? { ...a, value } : a,
                    ),
                  })
                }
              />
              <button
                type="button"
                onClick={() => {
                  keys.current.splice(i, 1);
                  update(index, {
                    ...step,
                    assignments: step.assignments.filter((_, n) => n !== i),
                  });
                }}
              >
                Remove assignment
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              update(index, {
                ...step,
                assignments: [
                  ...step.assignments,
                  {
                    fieldId: '',
                    operation: 'set',
                    value: { kind: 'literal', value: '' },
                  },
                ],
              })
            }
          >
            Add assignment
          </button>
        </>
      )}
    </>
  );
}
