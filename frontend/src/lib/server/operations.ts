import { eventFields, countFields } from '../observability';
import { projectDto, tableDto, pick } from './dto';
const uuid = '[a-f0-9-]{36}';
type Operation = {
  pattern: RegExp;
  methods: string[];
  mode: 'management' | 'runtime';
  project: (data: unknown, method: string) => unknown;
};
const keys = (names: string[]) => (data: unknown) =>
  Array.isArray(data) ? data.map((d) => pick(d, names)) : pick(data, names);
const connection = keys([
  'id',
  'revision',
  'label',
  'lastTestStatus',
  'lastTestedAt',
  'identity',
  'replacement',
  'createdAt',
  'updatedAt',
]);
const endpoint = keys([
  'id',
  'tableId',
  'resourceName',
  'enabledOperations',
  'policies',
  'revision',
]);
const workflow = keys([
  'id',
  'path',
  'enabled',
  'draftDefinition',
  'draftRevision',
  'publishedVersionId',
  'publishedDefinition',
  'readiness',
]);
const auth = keys([
  'enabled',
  'signupEnabled',
  'sessionLifetimeSeconds',
  'revision',
  'provisioningStatus',
  'blocked',
]);
const rule = (
  suffix: string,
  methods: string[],
  project: Operation['project'],
): Operation => ({
  pattern: new RegExp(`^projects/${uuid}/${suffix}$`),
  methods,
  mode: 'management',
  project,
});
export const operations: Operation[] = [
  rule('observability/summary', ['GET'], (data) => {
    const d = pick(data, ['window','asOf',...countFields,'p50DurationMs','p95DurationMs','topOperations','topErrorCodes']);
    return { ...d, topOperations: (d.topOperations as unknown[]).map((v) => pick(v, ['resource','operation',...countFields,'p95DurationMs'])), topErrorCodes: (d.topErrorCodes as unknown[]).map((v) => pick(v, ['errorCode','count'])) };
  }),
  rule('observability/requests', ['GET'], (data) => ({ items: ((data as { items: unknown[] }).items).map((v) => pick(v, eventFields)), nextCursor: (data as { nextCursor: unknown }).nextCursor })),
  rule(`observability/requests/${uuid}`, ['GET'], (data) => ({ items: ((data as { items: unknown[] }).items).map((v) => pick(v, eventFields)) })),
  {
    pattern: /^projects$/,
    methods: ['GET', 'POST'],
    mode: 'management',
    project: (d, m) =>
      m === 'GET'
        ? {
            items: (d as { items: unknown[] }).items.map(projectDto),
            nextOffset: (d as { nextOffset: unknown }).nextOffset,
          }
        : projectDto(d),
  },
  {
    pattern: new RegExp(`^projects/${uuid}$`),
    methods: ['GET'],
    mode: 'management',
    project: projectDto,
  },
  rule('database-connection', ['GET', 'POST', 'PUT', 'DELETE'], connection),
  rule('database-connection/credentials', ['PUT'], connection),
  rule('database-connection/test', ['POST'], connection),
  rule('schema', ['GET'], (d) => (d as unknown[]).map(tableDto)),
  rule('schema/reference-targets', ['GET'], (d) => {
    const value = pick(d, ['targets', 'unavailable']);
    return {
      ...value,
      targets: (value.targets as unknown[]).map((t) => pick(t, ['id', 'name'])),
    };
  }),
  rule('schema/tables', ['POST'], tableDto),
  rule(`schema/tables/${uuid}`, ['GET', 'DELETE'], tableDto),
  rule(`schema/tables/${uuid}/draft`, ['PUT'], tableDto),
  rule(
    `schema/tables/${uuid}/preview`,
    ['POST'],
    keys(['planHash', 'draftRevision', 'operation', 'sql', 'relationships', 'actions', 'version']),
  ),
  rule(`schema/tables/${uuid}/apply`, ['POST'], (d) => ({
    ...pick(d, ['migrationId', 'status']),
    table: tableDto((d as { table: unknown }).table),
  })),
  rule(`schema/tables/${uuid}/api`, ['GET', 'PUT'], endpoint),
  rule('endpoints', ['GET'], endpoint),
  // This route returns the backend's explicit public document DTO, never raw metadata.
  rule('openapi', ['GET'], (d) =>
    pick(d, ['openapi', 'info', 'servers', 'paths', 'components']),
  ),
  rule('sdk/typescript', ['GET'], (d) => pick(d, ['filename', 'generatorVersion', 'contractHash', 'tableRevisions', 'source'])),
  rule('api-keys', ['GET', 'POST'], (d, m) =>
    keys([
      'id',
      'name',
      'keyPrefix',
      'scope',
      'createdAt',
      'revokedAt',
      ...(m === 'POST' ? ['key'] : []),
    ])(d),
  ),
  rule(`api-keys/${uuid}`, ['DELETE'], (d) => d),
  rule('auth', ['GET', 'PUT'], auth),
  rule('auth/provision', ['POST'], auth),
  rule(`auth/users/${uuid}/role`, ['PATCH'], keys(['id', 'email', 'role'])),
  rule('workflows', ['GET', 'POST'], workflow),
  rule(`workflows/${uuid}`, ['GET', 'PATCH'], workflow),
  rule(`workflows/${uuid}/draft`, ['PUT'], workflow),
  rule(
    `workflows/${uuid}/preview`,
    ['POST'],
    keys([
      'definitionHash',
      'draftRevision',
      'requiredScope',
      'stepCount',
      'databaseStepCount',
      'schemaDependencies',
      'operations',
    ]),
  ),
  rule(
    `workflows/${uuid}/publish`,
    ['POST'],
    keys(['id', 'version', 'definition', 'definitionHash']),
  ),
  {
    pattern: /^[a-z][a-z0-9-]{2,62}\/auth\/me$/,
    methods: ['GET'],
    mode: 'runtime',
    project: (d) => d,
  },
  {
    pattern: /^[a-z][a-z0-9-]{2,62}\/auth\/(signup|login|logout)$/,
    methods: ['POST'],
    mode: 'runtime',
    project: (d) => d,
  },
  {
    pattern: /^[a-z][a-z0-9-]{2,62}\/[a-z][a-z0-9_-]{0,62}$/,
    methods: ['GET', 'POST'],
    mode: 'runtime',
    project: (d) => d,
  },
  {
    pattern: /^[a-z][a-z0-9-]{2,62}\/[a-z][a-z0-9_-]{0,62}\/[a-f0-9-]{36}$/,
    methods: ['GET', 'PATCH', 'DELETE'],
    mode: 'runtime',
    project: (d) => d,
  },
];
export function operationFor(path: string, method: string, runtime = false) {
  return operations.find(
    (o) =>
      o.mode === (runtime ? 'runtime' : 'management') &&
      o.pattern.test(path) &&
      o.methods.includes(method),
  );
}
