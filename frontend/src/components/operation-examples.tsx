'use client';
import { useState } from 'react';
import { includeOptions, operationById } from '@/lib/api-docs';
import type { OpenApiDocument } from '@/lib/api-docs';
import { operationExamples } from '@/lib/operation-examples';
import { CopyButton } from './copy-button';
export function OperationExamples({
  document,
  operationId,
  includes,
}: {
  document: OpenApiDocument;
  operationId: string;
  includes?: string[];
}) {
  const [queryExample, setQueryExample] = useState<'ordinary' | 'legacy' | 'range' | 'in' | 'null'>('ordinary');
  const [selected, setSelected] = useState<string[]>([]);
  const choices = includeOptions(operationById(document, operationId)?.operation);
  const current = includes ?? selected.filter((name) => choices.includes(name));
  const queryFields = operationById(document, operationId)?.operation['x-runtime-query']?.fields ?? [];
  const queryChoices = [
    { value: 'ordinary', label: 'Without filters', enabled: true },
    { value: 'legacy', label: 'Legacy equality', enabled: queryFields.length > 0 },
    { value: 'range', label: 'Range', enabled: queryFields.some((field) => field.operators.includes('gte')) },
    { value: 'in', label: 'IN', enabled: queryFields.some((field) => field.operators.includes('in')) },
    { value: 'null', label: 'NULL', enabled: queryFields.some((field) => field.operators.includes('is_null')) },
  ].filter((choice) => choice.enabled);
  const currentQuery = queryChoices.some((choice) => choice.value === queryExample) ? queryExample : 'ordinary';
  const examples = operationExamples(document, operationId, current, currentQuery);
  if (!examples)
    return (
      <p>
        This operation has no usable generated example. An update operation may
        have no writable fields. Review its deployed schema.
      </p>
    );
  return (
    <details>
      <summary>Integration examples</summary>
      {operationById(document, operationId)?.operation['x-runtime-query'] && <label>Query example<select value={currentQuery} onChange={(event) => setQueryExample(event.target.value as typeof queryExample)}>
        {queryChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select></label>}
      {includes === undefined && choices.length > 0 && <fieldset><legend>Include (maximum two)</legend>
        {choices.map((name) => <label key={name}><input type="checkbox" checked={current.includes(name)}
          disabled={!current.includes(name) && current.length >= 2}
          onChange={(event) => setSelected(event.target.checked ? [...current, name] : current.filter((value) => value !== name))} />{name}</label>)}
      </fieldset>}
      {[
        ['curl', examples.curl],
        ['JavaScript', examples.javascript],
      ].map(([label, code]) => (
        <section key={label}>
          <h4>{label}</h4>
          <pre>{code}</pre>
          <CopyButton
            text={code}
            label={`Copy ${label} example for ${operationId}`}
          />
        </section>
      ))}
      <p>
        API keys are project-scoped secrets. Keep API keys in trusted server
        code. Browser and mobile application bundles cannot keep embedded API
        keys secret.
      </p>
      <p>
        Browser applications must use an origin allowed by the deployment’s
        runtime CORS configuration. Browser CORS does not affect native, mobile,
        or server HTTP clients. Authentication is still required.
      </p>
    </details>
  );
}
