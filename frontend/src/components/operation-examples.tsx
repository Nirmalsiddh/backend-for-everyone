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
  const [selected, setSelected] = useState<string[]>([]);
  const choices = includeOptions(operationById(document, operationId)?.operation);
  const current = includes ?? selected.filter((name) => choices.includes(name));
  const examples = operationExamples(document, operationId, current);
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
