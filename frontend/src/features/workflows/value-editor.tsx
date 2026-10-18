'use client';
import { useEffect, useRef, useState } from 'react';
import type { Value } from '@/lib/contracts';
import type { ReferenceOption } from '@/lib/workflow';
export function ValueEditor({
  value,
  onChange,
  refs,
  label = 'Value',
  depth = 0,
}: {
  value: Value;
  onChange: (v: Value) => void;
  refs: ReferenceOption[];
  label?: string;
  depth?: number;
}) {
  const referenceRef = useRef<HTMLSelectElement>(null);
  const referenceValid =
    value.kind !== 'reference' ||
    refs.some((r) => JSON.stringify(r.value) === JSON.stringify(value));
  useEffect(() => {
    referenceRef.current?.setCustomValidity(
      referenceValid ? '' : 'Choose an available reference',
    );
  }, [referenceValid]);
  const [invalid, setInvalid] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const kind = value.kind === 'reference' ? 'reference' : value.kind;
  const [literalType, setLiteralType] = useState(
    value.kind === 'literal'
      ? value.value === null
        ? 'null'
        : typeof value.value
      : 'string',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const itemKeys = useRef<string[]>([]);
  const itemCounter = useRef(0);
  if (value.kind === 'array')
    while (itemKeys.current.length < value.items.length)
      itemKeys.current.push(`item_${itemCounter.current++}`);
  return (
    <div className="card">
      <label>
        {label} source
        <select
          value={kind}
          onChange={(e) => {
            setDraft(null);
            setInvalid('');
            inputRef.current?.setCustomValidity('');
            setLiteralType('string');
            if (e.target.value === 'reference')
              onChange(refs[0]?.value ?? { kind: 'literal', value: '' });
            else if (e.target.value === 'object')
              onChange({ kind: 'object', fields: {} });
            else if (e.target.value === 'array')
              onChange({ kind: 'array', items: [] });
            else onChange({ kind: 'literal', value: '' });
          }}
        >
          <option value="literal">Literal</option>
          <option value="reference" disabled={!refs.length}>
            Reference
          </option>
          {depth < 10 && (
            <>
              <option value="object">Object mapping</option>
              <option value="array">Array mapping</option>
            </>
          )}
        </select>
      </label>
      {value.kind === 'reference' && (
        <label>
          {label} reference
          <select
            ref={referenceRef}
            value={JSON.stringify(value)}
            onChange={(e) => onChange(JSON.parse(e.target.value) as Value)}
          >
            {!refs.some(
              (r) => JSON.stringify(r.value) === JSON.stringify(value),
            ) && (
              <option value={JSON.stringify(value)}>
                Unavailable reference — choose again
              </option>
            )}
            {refs.map((r) => (
              <option key={r.label} value={JSON.stringify(r.value)}>
                {r.label}
              </option>
            ))}
          </select>
          {!refs.some(
            (r) => JSON.stringify(r.value) === JSON.stringify(value),
          ) && (
            <p role="alert">
              This reference is no longer available here. Choose a declared
              input or an output from an earlier step in this branch.
            </p>
          )}
        </label>
      )}
      {value.kind === 'literal' && (
        <>
          <label>
            Literal type
            <select
              value={
                ['string', 'number', 'boolean', 'null', 'object'].includes(
                  literalType,
                )
                  ? literalType
                  : 'object'
              }
              onChange={(e) => {
                setDraft(null);
                setInvalid('');
                inputRef.current?.setCustomValidity('');
                setLiteralType(e.target.value);
                onChange({
                  kind: 'literal',
                  value:
                    e.target.value === 'number'
                      ? 0
                      : e.target.value === 'boolean'
                        ? false
                        : e.target.value === 'null'
                          ? null
                          : e.target.value === 'object'
                            ? {}
                            : '',
                });
              }}
            >
              <option value="string">
                String (also UUID, date, decimal, bigint)
              </option>
              <option value="number">Integer / number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
              <option value="object">JSON literal</option>
            </select>
          </label>
          {literalType === 'boolean' ? (
            <label>
              {label} literal
              <select
                value={String(value.value)}
                onChange={(e) =>
                  onChange({
                    kind: 'literal',
                    value: e.target.value === 'true',
                  })
                }
              >
                <option>true</option>
                <option>false</option>
              </select>
            </label>
          ) : (
            literalType !== 'null' && (
              <label>
                {label} literal
                <input
                  ref={inputRef}
                  value={
                    draft ??
                    (typeof value.value === 'string'
                      ? value.value
                      : JSON.stringify(value.value))
                  }
                  onChange={(e) => {
                    const text = e.target.value;
                    setDraft(text);
                    try {
                      const next =
                        literalType === 'number'
                          ? Number(text)
                          : literalType === 'object'
                            ? JSON.parse(text)
                            : text;
                      if (
                        literalType === 'number' &&
                        (!text.trim() || !Number.isFinite(next))
                      )
                        throw new Error('Enter a finite number');
                      setInvalid('');
                      e.target.setCustomValidity('');
                      onChange({ kind: 'literal', value: next });
                    } catch {
                      setInvalid('Invalid literal; correct it before saving');
                      e.target.setCustomValidity('Invalid literal');
                    }
                  }}
                  aria-invalid={!!invalid}
                />
              </label>
            )
          )}
          {invalid && <p role="alert">{invalid}</p>}
        </>
      )}
      {value.kind === 'object' && (
        <>
          <div className="row">
            <label>
              Object property
              <input value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={
                !key ||
                ['__proto__', 'constructor', 'prototype'].includes(key) ||
                Object.hasOwn(value.fields, key)
              }
              onClick={() => {
                onChange({
                  ...value,
                  fields: {
                    ...value.fields,
                    [key]: { kind: 'literal', value: '' },
                  },
                });
                setKey('');
              }}
            >
              Add property
            </button>
          </div>
          {Object.entries(value.fields).map(([name, v]) => (
            <div key={name}>
              <ValueEditor
                value={v}
                label={name}
                refs={refs}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...value,
                    fields: { ...value.fields, [name]: next },
                  })
                }
              />
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  onChange({
                    ...value,
                    fields: Object.fromEntries(
                      Object.entries(value.fields).filter(([k]) => k !== name),
                    ),
                  })
                }
              >
                Remove {name}
              </button>
            </div>
          ))}
        </>
      )}
      {value.kind === 'array' && (
        <>
          {value.items.map((v, i) => (
            <div key={itemKeys.current[i]}>
              <ValueEditor
                value={v}
                label={`Item ${i + 1}`}
                refs={refs}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...value,
                    items: value.items.map((x, n) => (n === i ? next : x)),
                  })
                }
              />
              <button
                type="button"
                onClick={() => {
                  itemKeys.current.splice(i, 1);
                  onChange({
                    ...value,
                    items: value.items.filter((_, n) => n !== i),
                  });
                }}
              >
                Remove item
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...value,
                items: [...value.items, { kind: 'literal', value: '' }],
              })
            }
          >
            Add item
          </button>
        </>
      )}
    </div>
  );
}
