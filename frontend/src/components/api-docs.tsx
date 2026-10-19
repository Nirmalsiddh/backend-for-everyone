'use client';
import { RuntimeErrorGuide } from '@/components/runtime-error-guide';
import Link from 'next/link';
import type { OpenApiDocument } from '@/lib/api-docs';
import {
  docOperations,
  playgroundHref,
  downloadDocument,
} from '@/lib/api-docs';
import { OperationExamples } from './operation-examples';
import { CredentialGuide, ApplicationLoginGuide } from './credential-guide';
import { Json } from './ui';
export function ApiDocs({
  document,
  projectId,
}: {
  document: OpenApiDocument;
  projectId: string;
}) {
  const operations = docOperations(document);
  return (
    <>
      <h1>API documentation</h1>
      <p>
        Deployed runtime contract. Drafts are excluded. Customer database
        availability is checked when a request executes.
      </p>
      <p>
        Base runtime URL: <code>{document.servers[0]?.url}</code>
      </p>
      <p>
        API keys and application sessions authenticate runtime requests.
        Dashboard sign-in does not authenticate runtime calls. Credentials below
        are placeholders.
      </p>
      <RuntimeErrorGuide />
      <CredentialGuide />
      <ApplicationLoginGuide />
      {operations.length === 0 && (
        <p>No deployed operations yet. Apply a table and enable an API.</p>
      )}
      <button type="button" onClick={() => downloadDocument(document)}>
        Download openapi.json
      </button>
      {['Resources', 'Authentication', 'Workflows'].map((group) => (
        <section key={group}>
          <h2>{group}</h2>
          {operations.filter(({ operation }) => operation.tags.includes(group))
            .length === 0 && <p>No deployed operations.</p>}
          {operations
            .filter(({ operation }) => operation.tags.includes(group))
            .map(({ path, method, operation }) => (
              <article key={operation.operationId}>
                <h3>
                  <strong>{method.toUpperCase()}</strong> <code>{path}</code>
                </h3>
                <p>{operation.summary}</p>
                <p>
                  Authentication:{' '}
                  <strong>
                    {
                      {
                        public: 'Public',
                        key_only: 'API key required',
                        authenticated: 'Signed-in application user',
                        owner: 'Record owner only',
                      }[operation['x-access-policy']]
                    }
                  </strong>
                </p>
                <p>{operation.description}</p>
                {operation.parameters && (
                  <details>
                    <summary>Parameters</summary>
                    <Json value={operation.parameters} />
                  </details>
                )}
                {operation.requestBody && (
                  <>
                    <details>
                      <summary>Request body schema</summary>
                      <Json
                        value={
                          operation.requestBody.content['application/json']
                            ?.schema
                        }
                      />
                    </details>
                    <h4>Request example</h4>
                    <Json
                      value={
                        operation.requestBody.content['application/json']
                          ?.example
                      }
                    />
                  </>
                )}
                <OperationExamples
                  document={document}
                  operationId={operation.operationId}
                />
                <h4>Responses</h4>
                {Object.entries(operation.responses).map(
                  ([status, response]) => (
                    <details key={status}>
                      <summary>
                        {status} — {response.description}
                      </summary>
                      {response.content ? (
                        <Json value={response.content} />
                      ) : (
                        <p>No content</p>
                      )}
                      {response.headers && <Json value={response.headers} />}
                    </details>
                  ),
                )}
                <Link href={playgroundHref(projectId, operation)}>
                  Try in Playground
                </Link>
              </article>
            ))}
        </section>
      ))}
    </>
  );
}
