import type {
  Auth,
  Connection,
  Endpoint,
  KeyMetadata,
  Table,
  Workflow,
} from './contracts';
import { workflowWrites } from './playground';
export type Metadata<T> = { data?: T; loading?: boolean; error?: boolean };
export type SetupStatus =
  | 'Ready'
  | 'Not configured'
  | 'Needs attention'
  | 'Blocked'
  | 'Optional'
  | 'Could not check';
export type SetupStep = {
  id: string;
  label: string;
  status: SetupStatus;
  detail: string;
  href: string;
};
export type SetupAction = { label: string; href: string };
export type VisitSuccess = {
  projectId: string;
  operationId: string;
  success: true;
};
export function deriveProjectSetupStatus(input: {
  projectId: string;
  connection: Metadata<Connection | null>;
  tables: Metadata<Table[]>;
  endpoints: Metadata<Endpoint[]>;
  auth: Metadata<Auth | null>;
  keys: Metadata<KeyMetadata[]>;
  workflows: Metadata<Workflow[]>;
  successes?: readonly VisitSuccess[];
}) {
  const base = `/projects/${input.projectId}`;
  const unknown = (q: Metadata<unknown>) =>
    !!(q.loading || q.error || q.data === undefined);
  const c = input.connection.data,
    tables = input.tables.data ?? [];
  const unresolved = tables.find(
    (t) => t.applyStatus?.status === 'outcome_unknown',
  );
  const running = tables.find((t) => t.applyStatus?.status === 'applying');
  const failed = tables.find((t) => t.applyStatus?.status === 'failed');
  const applied = tables.filter((t) => t.appliedRevision !== null);
  const authReady =
    !!input.auth.data?.enabled &&
    input.auth.data.provisioningStatus === 'ready' &&
    !input.auth.data.blocked;
  const connectionReady =
    !!c && c.lastTestStatus === 'success' && !unknown(input.connection);
  const globalSchemaBlock = !!unresolved || !!running || unknown(input.tables);
  const configured = (input.endpoints.data ?? []).flatMap((ep) =>
    ep.enabledOperations.map((op) => ({
      id: `crud_${ep.resourceName}_${op}`,
      label: `${ep.resourceName} ${op}`,
      mode: ep.policies?.[op]?.mode ?? 'key_only',
      writes: !['get', 'list'].includes(op),
      noWritableFields:
        op === 'update' &&
        !(
          applied.find((t) => t.id === ep.tableId)?.appliedDefinition
            ?.definition.fields ?? []
        ).some(
          (f) =>
            !Object.values(ep.policies ?? {}).some(
              (p) => p?.mode === 'owner' && p.ownerFieldId === f.id,
            ),
        ),
      schemaReady: applied.some(
        (t) =>
          !globalSchemaBlock &&
          t.id === ep.tableId &&
          !['outcome_unknown', 'applying', 'failed'].includes(
            t.applyStatus?.status ?? '',
          ),
      ),
    })),
  );
  const workflowOperations = (input.workflows.data ?? [])
    .filter((w) => w.enabled && w.publishedVersionId && w.publishedDefinition)
    .map((w) => ({
      id: `workflow_${w.path.replaceAll('-', '_')}`,
      label: w.path,
      mode: w.publishedDefinition!.auth,
      noWritableFields: false,
      writes: workflowWrites(w.publishedDefinition!.steps),
      schemaReady:
        w.readiness?.state === 'enabled' && !unknown(input.workflows),
    }));
  const operations = [...configured, ...workflowOperations];
  const needsAuth = operations.some((o) => o.mode !== 'key_only');
  const needsKey = operations.some((o) => o.mode === 'key_only');
  const hasKey = (writes: boolean) =>
    !unknown(input.keys) &&
    !!input.keys.data?.some(
      (k) =>
        !k.revokedAt &&
        (k.scope === 'read_write' || (!writes && k.scope === 'read')),
    );
  const missingKey = operations.some(
    (o) => o.mode === 'key_only' && !hasKey(o.writes),
  );
  const readyOperations = operations.map((o) => ({
    ...o,
    ready:
      connectionReady &&
      !globalSchemaBlock &&
      !o.noWritableFields &&
      o.schemaReady &&
      !unknown(input.tables) &&
      !unknown(input.endpoints) &&
      (o.mode === 'key_only'
        ? hasKey(o.writes)
        : authReady && !unknown(input.auth)),
  }));
  const tested = !!input.successes?.some(
    (s) =>
      s.projectId === input.projectId &&
      s.success &&
      operations.some((o) => o.id === s.operationId),
  );
  const steps: SetupStep[] = [];
  function step(
    id: string,
    label: string,
    q: Metadata<unknown>,
    status: SetupStatus,
    detail: string,
    route: string,
  ) {
    steps.push({
      id,
      label,
      status: unknown(q) ? 'Could not check' : status,
      detail: q.loading
        ? 'Loading saved metadata…'
        : unknown(q)
          ? 'Could not check saved metadata. Refresh to retry.'
          : detail,
      href: base + route,
    });
  }
  step(
    'database',
    'Connect PostgreSQL',
    input.connection,
    connectionReady ? 'Ready' : c ? 'Needs attention' : 'Not configured',
    c
      ? `Last saved test: ${c.lastTestStatus}. Historical evidence, not continuous monitoring.`
      : 'Connect the database that will hold your application data.',
    '/database',
  );
  step(
    'schema',
    'Tables & fields',
    input.tables,
    unresolved
      ? 'Blocked'
      : running || failed
        ? 'Needs attention'
        : applied.length
          ? 'Ready'
          : 'Not configured',
    unresolved
      ? 'Schema outcome unresolved. Review before retrying.'
      : running
        ? 'Schema operation in progress. Refresh saved status.'
        : failed
          ? 'Latest schema change failed. Review the table.'
          : applied.length
            ? `${applied.length} applied table(s).`
            : tables.length
              ? 'Preview and apply your saved draft.'
              : 'Create your first table.',
    '/schema',
  );
  step(
    'api',
    'Configure API operations',
    input.endpoints,
    configured.some((o) => o.noWritableFields)
      ? 'Needs attention'
      : configured.some((o) => o.schemaReady)
        ? 'Ready'
        : applied.length
          ? 'Not configured'
          : 'Blocked',
    configured.some((o) => o.noWritableFields)
      ? 'This update operation currently has no writable fields. Review API configuration.'
      : 'Enable operations on an applied table. Readiness is assessed separately for every operation.',
    '/apis',
  );
  step(
    'auth',
    'Application authentication',
    input.auth,
    needsAuth ? (authReady ? 'Ready' : 'Blocked') : 'Optional',
    needsAuth
      ? 'Required by signed-in-user or record-owner operations. Signup is optional.'
      : 'Needed only for signed-in-user or record-owner operations.',
    '/auth',
  );
  step(
    'keys',
    'Project API key',
    input.keys,
    needsKey ? (missingKey ? 'Not configured' : 'Ready') : 'Optional',
    needsKey
      ? 'Active read-only keys cover reads; writes need a read-and-write key. Revoked keys do not count.'
      : 'Signed-in-user APIs do not need an API key.',
    '/keys',
  );
  steps.push({
    id: 'test',
    label: 'Test your API',
    status: tested
      ? 'Ready'
      : readyOperations.some((o) => o.ready)
        ? 'Not configured'
        : 'Blocked',
    detail: tested
      ? 'Tested during this visit'
      : readyOperations.some((o) => o.ready)
        ? 'Configured — test your API.'
        : 'Configure a runtime operation before testing.',
    href: base + '/playground',
  });
  const blockedWorkflow = input.workflows.data?.find(
    (w) =>
      w.enabled && w.publishedVersionId && w.readiness?.state === 'blocked',
  );
  const optionalSteps: SetupStep[] = [
    {
      id: 'workflows',
      label: 'Workflows',
      status: unknown(input.workflows)
        ? 'Could not check'
        : blockedWorkflow
          ? 'Needs attention'
          : 'Optional',
      detail: blockedWorkflow
        ? `Workflow ${blockedWorkflow.path}: ${blockedWorkflow.readiness?.reasons.join('. ')} Republish or disable this workflow.`
        : 'Use workflows when one API request needs multiple database actions or business rules.',
      href:
        base +
        (blockedWorkflow ? `/workflows/${blockedWorkflow.id}` : '/workflows'),
    },
  ];
  let nextAction: SetupAction;
  const action = (label: string, route: string) => ({
    label,
    href: base + route,
  });
  const tableRoute = (t: Table) => `/schema/${t.id}`;
  if (unresolved)
    nextAction = action(
      'Review unresolved schema outcome',
      tableRoute(unresolved),
    );
  else if (running)
    nextAction = action(
      'Review schema operation in progress and refresh',
      tableRoute(running),
    );
  else if (unknown(input.connection))
    nextAction = action('Refresh database connection status', '/database');
  else if (!c) nextAction = action('Connect PostgreSQL', '/database');
  else if (!connectionReady)
    nextAction = action('Review and retest database connection', '/database');
  else if (unknown(input.tables))
    nextAction = action('Refresh tables & fields status', '/schema');
  else if (failed)
    nextAction = action('Review failed schema change', tableRoute(failed));
  else if (!tables.length)
    nextAction = action('Create your first table', '/schema');
  else if (!applied.length)
    nextAction = action(
      `Preview and apply ${tables[0].name}`,
      tableRoute(tables[0]),
    );
  else if (unknown(input.endpoints))
    nextAction = action('Refresh API configuration', '/apis');
  else if (!configured.some((o) => o.schemaReady))
    nextAction = action(`Configure ${applied[0].name} API`, '/apis');
  else if (needsAuth && unknown(input.auth))
    nextAction = action('Check application authentication', '/auth');
  else if (needsAuth && !authReady)
    nextAction = action('Set up application authentication', '/auth');
  else if (needsKey && unknown(input.keys))
    nextAction = action('Check API-key metadata', '/keys');
  else if (missingKey) nextAction = action('Create an API key', '/keys');
  else if (configured.some((o) => o.noWritableFields))
    nextAction = action(
      'Review update operations with no writable fields',
      '/apis',
    );
  else if (blockedWorkflow)
    nextAction = action(
      `Republish or disable ${blockedWorkflow.path}`,
      `/workflows/${blockedWorkflow.id}`,
    );
  else if (!tested)
    nextAction = action(
      `Test ${readyOperations.find((o) => o.ready)?.label ?? 'your API'} in Playground`,
      `/playground?operationId=${encodeURIComponent(readyOperations.find((o) => o.ready)?.id ?? '')}`,
    );
  else
    nextAction = action('View Docs and copy an integration example', '/docs');
  return {
    steps,
    nextAction,
    blockers: [...steps, ...optionalSteps].filter((s) =>
      ['Blocked', 'Needs attention', 'Could not check'].includes(s.status),
    ),
    readyOperations,
    optionalSteps,
    tested,
    currentReady:
      readyOperations.some((o) => o.ready) &&
      ![...steps, ...optionalSteps].some(
        (s) =>
          ['Blocked', 'Needs attention', 'Could not check'].includes(
            s.status,
          ) && s.id !== 'test',
      ),
  };
}
