'use client';
import { useState } from 'react';
import type { Definition, Step, Table, Value } from '@/lib/contracts';
import { references, newStep, terminates, insertStep } from '@/lib/workflow';
import { ValueEditor } from './value-editor';
import { DatabaseControls } from './database-controls';
export function Steps({
  steps,
  onChange,
  def,
  tables,
  incoming = [],
  depth = 0,
}: {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  def: Definition;
  tables: Table[];
  incoming?: Step[];
  depth?: number;
}) {
  const [kind, setKind] = useState<Step['type']>('query');
  function update(index: number, step: Step) {
    onChange(steps.map((s, i) => (i === index ? step : s)));
  }
  function move(i: number, delta: number) {
    const copy = [...steps];
    [copy[i], copy[i + delta]] = [copy[i + delta], copy[i]];
    onChange(copy);
  }
  function add(index?: number) {
    onChange(
      insertStep(
        steps,
        newStep(kind, `step_${crypto.randomUUID().slice(0, 8)}`, def.auth),
        index,
      ),
    );
  }
  let terminated = false;
  return (
    <div data-testid={`steps-depth-${depth}`}>
      {steps.map((step, index) => {
        const refs = references(
          def,
          [...incoming, ...steps.slice(0, index)],
          tables,
        );
        const unreachable = terminated;
        if (
          step.type === 'response' ||
          (step.type === 'condition' &&
            terminates(step.then) &&
            terminates(step.else))
        )
          terminated = true;
        return (
          <fieldset key={step.id} data-testid="workflow-step">
            <legend>
              {index + 1}. {step.type}
              {unreachable ? ' · unreachable, move/remove' : ''}
            </legend>
            <label>
              Step name
              <input
                value={step.name}
                required
                pattern="[a-z][a-z0-9_]{0,62}"
                onChange={(e) =>
                  update(index, { ...step, name: e.target.value })
                }
              />
            </label>
            <div>
              <button type="button" onClick={() => add(index)}>
                Add before
              </button>
              <button type="button" onClick={() => add(index + 1)}>
                Add after
              </button>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (
                    step.type !== 'condition' ||
                    confirm(
                      'Remove this condition and all steps in its Then and Else branches?',
                    )
                  )
                    onChange(steps.filter((_, i) => i !== index));
                }}
              >
                Remove step
              </button>
            </div>
            <DatabaseControls
              step={step}
              index={index}
              update={update}
              def={def}
              tables={tables}
              refs={refs}
            />
            {step.type === 'condition' && (
              <>
                <label>
                  Comparison
                  <select
                    value={step.operator}
                    onChange={(e) => {
                      const next = {
                        ...step,
                        operator: e.target.value as Extract<
                          Step,
                          { type: 'condition' }
                        >['operator'],
                      };
                      if (['is_null', 'is_not_null'].includes(e.target.value))
                        delete next.right;
                      else next.right ??= { kind: 'literal', value: '' };
                      update(index, next);
                    }}
                  >
                    {[
                      'equals',
                      'not_equals',
                      'greater_than',
                      'greater_or_equal',
                      'less_than',
                      'less_or_equal',
                      'is_null',
                      'is_not_null',
                    ].map((op) => (
                      <option key={op}>{op}</option>
                    ))}
                  </select>
                </label>
                <ValueEditor
                  label="Left"
                  value={step.left}
                  refs={refs}
                  onChange={(left) => update(index, { ...step, left })}
                />
                {step.right && (
                  <ValueEditor
                    label="Right"
                    value={step.right}
                    refs={refs}
                    onChange={(right) => update(index, { ...step, right })}
                  />
                )}
                <div className="branch">
                  <h3>Then</h3>
                  <Steps
                    steps={step.then}
                    onChange={(then) => update(index, { ...step, then })}
                    def={def}
                    tables={tables}
                    incoming={[...incoming, ...steps.slice(0, index)]}
                    depth={depth + 1}
                  />
                  <h3>Else</h3>
                  <Steps
                    steps={step.else}
                    onChange={(other) =>
                      update(index, { ...step, else: other })
                    }
                    def={def}
                    tables={tables}
                    incoming={[...incoming, ...steps.slice(0, index)]}
                    depth={depth + 1}
                  />
                </div>
              </>
            )}
            {step.type === 'response' && (
              <>
                <label>
                  Response status
                  <select
                    value={step.status}
                    onChange={(e) =>
                      update(index, {
                        id: step.id,
                        name: step.name,
                        type: 'response',
                        status: Number(e.target.value) as Extract<
                          Step,
                          { type: 'response' }
                        >['status'],
                        ...(Number(e.target.value) === 204
                          ? {}
                          : {
                              body: step.body ?? { kind: 'object', fields: {} },
                            }),
                      })
                    }
                  >
                    {[200, 201, 204, 400, 403, 404, 409, 422].map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </label>
                {step.body && (
                  <ValueEditor
                    label="Response body"
                    value={step.body}
                    refs={refs}
                    onChange={(body) => update(index, { ...step, body })}
                  />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      <div className="row">
        <label>
          New step type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Step['type'])}
          >
            {['query', 'insert', 'update', 'delete', 'condition', 'response']
              .filter((k) => k !== 'condition' || depth < 3)
              .map((k) => (
                <option key={k}>{k}</option>
              ))}
          </select>
        </label>
        <button type="button" onClick={() => add()}>
          {depth > 0 ? 'Add inside branch' : 'Add step'}
        </button>
      </div>
    </div>
  );
}
