'use client';
import { useState } from 'react';
import type { InputField } from '@/lib/contracts';
export function InputsEditor({
  input,
  onChange,
}: {
  input: Record<string, InputField>;
  onChange: (value: Record<string, InputField>) => void;
}) {
  const [inputName, setInputName] = useState('');
  function setField(name: string, value: InputField) {
    onChange({ ...input, [name]: value });
  }
  return (
    <section>
      <h2>Input declaration</h2>
      <div className="row">
        <label>
          Input name
          <input
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={
            !/^[a-z][a-z0-9_]{0,62}$/.test(inputName) ||
            Object.hasOwn(input, inputName) ||
            Object.keys(input).length >= 100 ||
            ['constructor', 'prototype', '__proto__'].includes(inputName)
          }
          onClick={() => {
            setField(inputName, { type: 'string', required: true });
            setInputName('');
          }}
        >
          Add input
        </button>
      </div>
      {Object.entries(input).map(([name, field]) => (
        <fieldset key={name}>
          <legend>{name}</legend>
          <label>
            Input type
            <select
              value={field.type}
              onChange={(e) =>
                setField(name, {
                  type: e.target.value as InputField['type'],
                  required: field.required,
                  nullable: field.nullable,
                })
              }
            >
              {['uuid', 'string', 'integer', 'boolean'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={field.required ?? false}
              onChange={(e) =>
                setField(name, { ...field, required: e.target.checked })
              }
            />
            Required
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={field.nullable ?? false}
              onChange={(e) =>
                setField(name, { ...field, nullable: e.target.checked })
              }
            />
            Nullable
          </label>
          {(field.type === 'integer'
            ? ['min', 'max']
            : field.type === 'string'
              ? ['minLength', 'maxLength']
              : []
          ).map((key) => (
            <label key={key}>
              {key}
              <input
                type="number"
                value={(field[key as keyof InputField] as number) ?? ''}
                onChange={(e) => {
                  const next = { ...field };
                  if (e.target.value === '') delete next[key as 'min'];
                  else next[key as 'min'] = Number(e.target.value);
                  setField(name, next);
                }}
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange(
                Object.fromEntries(
                  Object.entries(input).filter(([k]) => k !== name),
                ),
              )
            }
          >
            Remove input
          </button>
        </fieldset>
      ))}
    </section>
  );
}
