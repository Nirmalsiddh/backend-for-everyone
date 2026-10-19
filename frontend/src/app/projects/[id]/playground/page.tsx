'use client';
import { RuntimeErrorGuide } from '@/components/runtime-error-guide';
import { recordRuntimeSuccess } from '@/lib/project-visit';
import { OperationExamples } from '@/components/operation-examples';
import { docOperations } from '@/lib/api-docs';
import {
  CredentialGuide,
  ApplicationLoginGuide,
} from '@/components/credential-guide';
import { useRef, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import {
  RequestSequence,
  parseResponse,
  exampleBody,
  workflowWrites,
} from '@/lib/playground';
import { api } from '@/lib/api';
import { operationById, type OpenApiDocument } from '@/lib/api-docs';
import { ApiError } from '@/lib/api';
import type {
  Project,
  Endpoint,
  Workflow,
  Operation,
  Table,
  Auth,
} from '@/lib/contracts';
import { useData, State, ErrorBox, Json } from '@/components/ui';
type Form = {
  target: string;
  recordId: string;
  body: string;
  limit: string;
  offset: string;
  sort: string;
  direction: string;
  filters: string;
  credentialMode: string;
  credential: string;
};
type Result = {
  status: number;
  body: unknown;
  empty: boolean;
  headers: Record<string, string>;
  requestId: string;
  elapsed: number;
};
const method: Record<Operation, string> = {
  list: 'GET',
  get: 'GET',
  create: 'POST',
  update: 'PATCH',
  delete: 'DELETE',
};
function Playground() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [runtimeOrigin, setRuntimeOrigin] = useState('');
  useEffect(() => {
    setRuntimeOrigin(
      document
        .querySelector('meta[name="runtime-origin"]')
        ?.getAttribute('content') ?? '',
    );
  }, []);
  const docs = useData<OpenApiDocument>(`projects/${id}/openapi`);
  const p = useData<Project>(`projects/${id}`);
  const e = useData<Endpoint[]>(`projects/${id}/endpoints`);
  const w = useData<Workflow[]>(`projects/${id}/workflows`);
  const tables = useData<Table[]>(`projects/${id}/schema`);
  const auth = useData<Auth>(`projects/${id}/auth`);
  const sequence = useRef(new RequestSequence()).current;
  const [session, setSession] = useState<{
    user: unknown;
    expiresAt: string;
  } | null>(null);
  useEffect(() => () => sequence.invalidate(), [sequence, id]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const f = useForm<Form>({
    defaultValues: {
      target: search.get('target') ?? '',
      recordId: '',
      body: '{}',
      limit: '',
      offset: '',
      sort: '',
      direction: '',
      filters: '',
      credentialMode: 'none',
      credential: '',
    },
  });
  const values = f.watch();
  const choices = [
    ...(e.data ?? []).flatMap((ep) =>
      ep.enabledOperations.map((op) => ({
        id: `table:${ep.id}:${op}`,
        label: `${method[op]} ${ep.resourceName}${['get', 'update', 'delete'].includes(op) ? '/:id' : ''}`,
        resource: ep.resourceName,
        method: method[op],
        record: ['get', 'update', 'delete'].includes(op),
        list: op === 'list',
      })),
    ),
    ...['signup', 'login', 'me', 'logout'].map((action) => ({
      id: `auth:${action}`,
      label: `${action === 'me' ? 'GET' : 'POST'} auth/${action}`,
      resource: `auth/${action}`,
      method: action === 'me' ? 'GET' : 'POST',
      record: false,
      list: false,
    })),
    ...(w.data ?? [])
      .filter(
        (w) =>
          w.publishedVersionId &&
          w.enabled &&
          w.publishedDefinition &&
          w.readiness?.state !== 'blocked' &&
          w.readiness?.state !== 'stale',
      )
      .map((w) => ({
        id: `workflow:${w.id}`,
        label: `POST ${w.path} (${w.enabled ? 'enabled' : 'disabled'})`,
        resource: w.path,
        method: 'POST',
        record: false,
        list: false,
      })),
  ];
  const target = choices.find((c) => c.id === values.target);
  const selectedEndpoint = e.data?.find((ep) =>
    values.target.startsWith(`table:${ep.id}:`),
  );
  const selectedOperation = values.target.split(':')[2] as Operation;
  const policy = selectedEndpoint?.policies?.[selectedOperation] ?? {
    mode: 'key_only',
  };
  const selectedTable = tables.data?.find(
    (t) => t.id === selectedEndpoint?.tableId,
  );
  const selectedWorkflow = w.data?.find(
    (w) => values.target === `workflow:${w.id}`,
  );
  const deployedOperation =
    docs.data &&
    docOperations(docs.data).find(
      (o) =>
        target &&
        o.method.toUpperCase() === target.method &&
        o.path === `/${target.resource}${target.record ? '/{id}' : ''}`,
    );
  const runtimeContext = target?.resource.startsWith('auth/')
    ? ['auth/login', 'auth/signup'].includes(target.resource)
      ? 'public'
      : 'session'
    : selectedWorkflow
      ? selectedWorkflow.publishedDefinition?.auth === 'key_only'
        ? 'key'
        : 'session'
      : policy.mode === 'key_only'
        ? 'key'
        : 'session';
  const handoff = search.get('operationId');
  const handled = useRef('');
  useEffect(() => {
    if (
      !handoff ||
      !e.data ||
      !w.data ||
      !tables.data ||
      auth.isPending ||
      handled.current === handoff
    )
      return;
    let cancelled = false;
    void api<OpenApiDocument>(`projects/${id}/openapi`)
      .then((doc) => {
        if (cancelled || handled.current === handoff) return;
        const match = operationById(doc, handoff);
        const choice =
          match &&
          choices.find(
            (c) =>
              c.method.toLowerCase() === match.method &&
              `/${c.resource}${c.record ? '/{id}' : ''}` === match.path,
          );
        if (!match || !choice)
          throw new Error(
            'This deployed operation is no longer available. Reload Docs.',
          );
        handled.current = handoff;
        f.setValue('target', choice.id);
        f.setValue(
          'body',
          JSON.stringify(
            match.operation.requestBody?.content['application/json']?.example ??
              {},
            null,
            2,
          ),
        );
        f.setValue(
          'credentialMode',
          match.operation['x-access-policy'] === 'public'
            ? 'none'
            : match.operation['x-access-policy'] === 'key_only'
              ? 'key'
              : 'session',
        );
        f.setValue('credential', '');
        setError(null);
        setResult(null);
      })
      .catch((error: unknown) => {
        if (!cancelled && handled.current !== handoff) {
          handled.current = handoff;
          f.setValue('target', '');
          setError(error);
        }
      });
    return () => {
      cancelled = true;
    };
    // Resolve only after metadata loads; no request execution occurs in this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, id, e.data, w.data, tables.data, auth.data, auth.isPending]);
  function generateExample() {
    if (selectedTable)
      f.setValue(
        'body',
        JSON.stringify(
          exampleBody(
            selectedTable.appliedDefinition?.definition.fields ?? [],
            policy.mode === 'owner' ? policy.ownerFieldId : undefined,
          ),
          null,
          2,
        ),
      );
    else if (selectedWorkflow)
      f.setValue(
        'body',
        JSON.stringify(
          Object.fromEntries(
            Object.entries(selectedWorkflow.publishedDefinition!.input).map(
              ([name, field]) => [
                name,
                field.type === 'boolean'
                  ? true
                  : field.type === 'integer'
                    ? 1
                    : field.type === 'uuid'
                      ? '00000000-0000-4000-8000-000000000000'
                      : 'example',
              ],
            ),
          ),
          null,
          2,
        ),
      );
  }
  function invalidate() {
    sequence.invalidate();
    setResult(null);
    setError(null);
    setBusy(false);
  }
  function select(value: string) {
    handled.current = handoff ?? '';
    invalidate();
    f.setValue('target', value);
    const preset = value === 'auth:signup' || value === 'auth:login';
    f.setValue(
      'body',
      preset
        ? JSON.stringify(
            { email: 'developer@example.test', password: '' },
            null,
            2,
          )
        : '{}',
    );
    setResult(null);
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('operationId');
    url.searchParams.set('target', value);
    window.history.replaceState(null, '', url);
  }
  return (
    <>
      <h1>API playground</h1>
      <RuntimeErrorGuide />
      <CredentialGuide />
      <ApplicationLoginGuide />
      <p>
        Requests operate on your connected database. Credentials remain in this
        page’s memory only.
      </p>
      <p>
        Runtime URL:{' '}
        <code>
          {runtimeOrigin}/api/{p.data?.slug}/{target?.resource ?? '…'}
        </code>
      </p>
      <p>Playground requests do not test your application's CORS settings.</p>
      {target && (
        <section>
          <p>
            Credential requirement:{' '}
            {target.resource.startsWith('auth/')
              ? ['auth/signup', 'auth/login'].includes(target.resource)
                ? 'No credential; supply email and password.'
                : 'Application session token'
              : selectedWorkflow
                ? selectedWorkflow.publishedDefinition!.auth === 'key_only'
                  ? 'API key required'
                  : 'Signed-in user required'
                : policy.mode === 'key_only'
                  ? 'API key required'
                  : policy.mode === 'owner'
                    ? 'Record owner session required'
                    : 'Signed-in user required'}
          </p>
          {target.resource === 'auth/signup' && (
            <p>
              Use an email and a password of at least 15 characters. Signup
              creates the user; login starts a session.
            </p>
          )}
          {target.resource === 'auth/login' && (
            <p>
              Use the email and password from signup. A successful login
              activates the session token in memory and shows its identity and
              expiry.
            </p>
          )}
          {selectedTable && (
            <p>
              Required fields:{' '}
              {selectedTable.appliedDefinition?.definition.fields
                .filter(
                  (f) =>
                    !f.nullable && !f.default && f.id !== policy.ownerFieldId,
                )
                .map((f) => f.name)
                .join(', ') || 'None'}
              . Query options: limit, offset (up to 10000), scalar sort and up
              to five equality filters.
            </p>
          )}
          <button type="button" onClick={generateExample}>
            Generate example body
          </button>
          {target.resource.startsWith('auth/') && !auth.data?.enabled && (
            <p>
              Authentication is not ready. Configure and create authentication
              tables first.
            </p>
          )}
        </section>
      )}
      <State query={p}>
        <State query={e}>
          <State query={w}>
            <form
              onSubmit={f.handleSubmit(async (v) => {
                const request = sequence.start();
                setBusy(true);
                setError(null);
                setResult(null);
                try {
                  if (!target || !p.data) throw new Error('Choose an endpoint');
                  if (target.record && !/^[a-f0-9-]{36}$/.test(v.recordId))
                    throw new Error('Enter a record UUID');
                  if (
                    target.method === 'DELETE' &&
                    !confirm(
                      'Delete this record from the connected database? This cannot be undone here.',
                    )
                  )
                    return;
                  if (
                    selectedWorkflow &&
                    workflowWrites(
                      selectedWorkflow.publishedDefinition!.steps,
                    ) &&
                    !confirm(
                      'This workflow may write to your connected database. Send this request?',
                    )
                  )
                    return;
                  const query = new URLSearchParams();
                  if (target.list) {
                    for (const key of [
                      'limit',
                      'offset',
                      'sort',
                      'direction',
                    ] as const)
                      if (v[key]) query.set(key, v[key]);
                    if (v.filters) {
                      const filters = JSON.parse(v.filters);
                      if (
                        !filters ||
                        Array.isArray(filters) ||
                        typeof filters !== 'object'
                      )
                        throw new Error('Filters must be a JSON object');
                      for (const [key, value] of Object.entries(filters))
                        query.set(`filter[${key}]`, String(value));
                    }
                  }
                  const headers: Record<string, string> = {};
                  if (v.credentialMode !== 'none') {
                    if (!v.credential)
                      throw new Error('Enter a runtime credential');
                    headers.authorization = `Bearer ${v.credential}`;
                  }
                  const wantsBody =
                    ['POST', 'PATCH'].includes(target.method) &&
                    !['auth/logout'].includes(target.resource);
                  const body = wantsBody
                    ? JSON.stringify(JSON.parse(v.body))
                    : undefined;
                  if (body) headers['content-type'] = 'application/json';
                  const start = performance.now();
                  const response = await fetch(
                    `/api/runtime/${p.data.slug}/${target.resource}${target.record ? '/' + v.recordId : ''}${query.size ? '?' + query : ''}`,
                    {
                      method: target.method,
                      headers,
                      body,
                      cache: 'no-store',
                      signal: request.signal,
                    },
                  );
                  const text = await response.text();
                  if (!sequence.current(request.id)) return;
                  const parsed = parseResponse(text);
                  let data = parsed.body;
                  if (
                    response.ok &&
                    target.resource === 'auth/login' &&
                    data &&
                    typeof data === 'object' &&
                    'token' in data &&
                    typeof data.token === 'string'
                  ) {
                    const login = data as {
                      token: string;
                      user: unknown;
                      expiresIn?: number;
                    };
                    f.setValue('credential', login.token);
                    f.setValue('credentialMode', 'session');
                    setSession({
                      user: login.user,
                      expiresAt: new Date(
                        Date.now() + (login.expiresIn ?? 0) * 1000,
                      ).toISOString(),
                    });
                    const { token: _token, ...safe } = login;
                    data = safe;
                  }
                  if (response.ok && target.resource === 'auth/logout') {
                    f.setValue('credential', '');
                    f.setValue('credentialMode', 'none');
                    setSession(null);
                  }
                  if (deployedOperation && !target.id.startsWith('auth:'))
                    recordRuntimeSuccess(
                      id,
                      deployedOperation.operation.operationId,
                      response.status,
                    );
                  setResult({
                    status: response.status,
                    body: data,
                    empty: parsed.empty,
                    headers: Object.fromEntries(
                      [
                        'content-type',
                        'location',
                        'retry-after',
                        'x-request-id',
                      ].flatMap((k) =>
                        response.headers.has(k)
                          ? [[k, response.headers.get(k)!]]
                          : [],
                      ),
                    ),
                    requestId: response.headers.get('x-request-id') ?? '',
                    elapsed: Math.round(performance.now() - start),
                  });
                  if (!response.ok) {
                    const d = data as { code?: string; message?: string };
                    setError(
                      new ApiError(
                        response.status,
                        d?.code ?? 'REQUEST_FAILED',
                        d?.message ?? 'Request failed',
                        response.headers.get('x-request-id') ?? undefined,
                      ),
                    );
                  }
                } catch (err) {
                  if (sequence.current(request.id)) setError(err);
                } finally {
                  if (sequence.current(request.id)) setBusy(false);
                  if (
                    sequence.current(request.id) &&
                    ['auth/signup', 'auth/login'].includes(
                      target?.resource ?? '',
                    )
                  ) {
                    try {
                      const safe = JSON.parse(v.body);
                      delete safe.password;
                      f.setValue(
                        'body',
                        JSON.stringify({ ...safe, password: '' }, null, 2),
                      );
                    } catch {
                      f.setValue('body', '{}');
                    }
                  }
                }
              })}
            >
              <label>
                Endpoint
                <select
                  value={values.target}
                  onChange={(e) => select(e.target.value)}
                >
                  <option value="">Choose endpoint</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {target && (
                <p>
                  Method: <strong>{target.method}</strong> · Path:{' '}
                  <code>
                    /api/{p.data?.slug}/{target.resource}
                  </code>
                </p>
              )}
              {target?.record && (
                <label>
                  Record UUID
                  <input {...f.register('recordId')} required />
                </label>
              )}
              {target?.list && (
                <>
                  <div className="row">
                    <label>
                      Limit
                      <input
                        type="number"
                        {...f.register('limit')}
                        min={1}
                        max={100}
                      />
                    </label>
                    <label>
                      Offset
                      <input type="number" {...f.register('offset')} min={0} />
                    </label>
                    <label>
                      Sort field
                      <input {...f.register('sort')} />
                    </label>
                    <label>
                      Direction
                      <select {...f.register('direction')}>
                        <option value="">Default</option>
                        <option value="asc">asc</option>
                        <option value="desc">desc</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Equality filters (JSON object, up to five)
                    <input
                      {...f.register('filters')}
                      placeholder='{"title":"example"}'
                    />
                  </label>
                </>
              )}
              {target &&
                ['POST', 'PATCH'].includes(target.method) &&
                target.resource !== 'auth/logout' && (
                  <label>
                    JSON request body
                    <textarea {...f.register('body')} rows={8} />
                  </label>
                )}
              <label>
                Credential mode
                <select
                  {...f.register('credentialMode', {
                    onChange: () => {
                      invalidate();
                      f.setValue('credential', '');
                      setSession(null);
                    },
                  })}
                >
                  <option value="none">None</option>
                  <option value="key">API key</option>
                  <option value="session">Application session token</option>
                </select>
              </label>
              {values.credentialMode !== 'none' && (
                <label>
                  Runtime credential
                  <input
                    type="password"
                    {...f.register('credential', {
                      onChange: () => {
                        invalidate();
                        setSession(null);
                      },
                    })}
                    autoComplete="off"
                  />
                </label>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  invalidate();
                  setSession(null);
                  f.setValue('credential', '');
                  f.setValue('credentialMode', 'none');
                  if (
                    target?.resource === 'auth/login' ||
                    target?.resource === 'auth/signup'
                  ) {
                    try {
                      const body = JSON.parse(f.getValues('body'));
                      delete body.password;
                      f.setValue(
                        'body',
                        JSON.stringify({ ...body, password: '' }, null, 2),
                      );
                    } catch {
                      f.setValue('body', '{}');
                    }
                  }
                }}
              >
                Clear credentials and response
              </button>
              <button disabled={busy || !target}>
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </form>
          </State>
        </State>
      </State>
      {session && (
        <section>
          <h2>Active application session</h2>
          <p>
            Identity: {JSON.stringify(session.user)} · Expires{' '}
            {session.expiresAt}
          </p>
          <p>The session token remains only in transient credential state.</p>
        </section>
      )}
      <p>
        Stopping the browser wait does not undo a submitted write. Review saved
        state before retrying.
      </p>
      <ErrorBox error={error} context={runtimeContext} />
      {docs.data && deployedOperation && (
        <OperationExamples
          document={docs.data}
          operationId={deployedOperation.operation.operationId}
        />
      )}
      {result && (
        <section>
          <h2>Response</h2>
          <p data-testid="response-status">HTTP {result.status}</p>
          <p>Elapsed: {result.elapsed} ms</p>
          <p>Request ID: {result.requestId || 'unavailable'}</p>
          <div data-testid="response-body">
            {result.empty ? (
              <p>Empty response</p>
            ) : (
              <Json value={result.body} />
            )}
          </div>
          <details>
            <summary>Response headers</summary>
            <Json value={result.headers} />
          </details>
        </section>
      )}
    </>
  );
}

export default function PlaygroundPage() {
  const { id } = useParams<{ id: string }>();
  return <Playground key={id} />;
}
