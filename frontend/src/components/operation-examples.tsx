'use client';
import type { OpenApiDocument } from '@/lib/api-docs';
import { operationExamples } from '@/lib/operation-examples';
import { CopyButton } from './copy-button';
export function OperationExamples({
  document,
  operationId,
}: {
  document: OpenApiDocument;
  operationId: string;
}) {
  const examples = operationExamples(document, operationId);
  if (!examples)
    return <p>Could not generate examples for this deployed operation.</p>;
  return (
    <details>
      <summary>Integration examples</summary>
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
