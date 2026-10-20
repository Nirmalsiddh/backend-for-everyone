import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Validator } from '@seriousme/openapi-schema-validator';
import { generate } from '../src/modules/api-docs/service.js';
import { fieldSchema } from '../src/modules/api-docs/schemas.js';
import { synthetic } from '../src/modules/api-docs/examples.js';
import { infer } from '../src/modules/api-docs/workflows.js';
import {
  validateBody,
  validateList,
  validateValue,
} from '../src/runtime/validation.js';
import { credentials } from '../src/modules/project-auth/service.js';
import { buildApp } from '../src/app.js';
import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import { env, auth, ownerId, memoryRepository } from './helpers.js';
import type { DocsSnapshot } from '../src/modules/api-docs/types.js';
import { field, snapshot } from './api-docs-fixtures.js';
const origin = 'https://api.example.test';
test('OpenAPI 3.1 validates on Node 24; deterministic deployed CRUD, auth and workflow contracts', async () => {
  const input = snapshot(),
    doc = generate(input, origin);
  const result = await new Validator().validate(
    doc as unknown as Record<string, unknown>,
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0]!.url, origin + '/api/docs-project');
  assert.equal(JSON.stringify(doc), JSON.stringify(generate(input, origin)));
  input.resources[0]!.operations.reverse();
  input.resources[0]!.fields!.reverse();
  assert.equal(JSON.stringify(doc), JSON.stringify(generate(input, origin)));
  assert.equal(doc.paths['/tasks']!.post!.operationId, 'crud_tasks_create');
  assert.equal(
    doc.paths['/place-order']!.post!.operationId,
    'workflow_place_order',
  );
  assert.deepEqual(doc.paths['/tasks']!.post!.security, [
    { ApplicationSession: [] },
  ]);
  const create =
    doc.paths['/tasks']!.post!.requestBody!.content['application/json']!;
  assert.deepEqual(create.schema.required, ['title']);
  assert.deepEqual(Object.keys(create.schema.properties!), ['done', 'title']);
  const patch =
    doc.paths['/tasks/{id}']!.patch!.requestBody!.content['application/json']!;
  assert.equal(patch.schema.minProperties, 1);
  assert.equal(patch.schema.additionalProperties, false);
  assert.ok(!patch.schema.properties!.owner_id && !patch.schema.properties!.id);
  assert.ok(doc.paths['/tasks']!.post!.responses['201']!.headers!.Location);
  assert.ok(!doc.paths['/tasks/{id}']!.delete!.responses['204']!.content);
  assert.ok(doc.paths['/place-order']!.post!.responses['201']);
  const custom =
    doc.paths['/place-order']!.post!.responses['409']!.content![
      'application/json'
    ]!.schema;
  assert.equal(custom.properties!.reason!.type, 'string');
  assert.ok(doc.paths['/auth/signup']!.post!.responses['201']);
  assert.ok(!doc.paths['/auth/signup']!.post!.responses['202']);
  for (const forbidden of [
    'literal-secret-sentinel',
    'internal-field-',
    'internal-step',
    'internal-table',
    'success-step',
    'rejection-step',
    'ps_',
    'sqlTemplate',
    'ownerFieldId',
    'definitionHash',
  ])
    assert.ok(!JSON.stringify(doc).includes(forbidden), forbidden);
});
test('all type mappings, nullability and synthetic values match runtime validation', () => {
  for (const type of [
    'text',
    'varchar',
    'integer',
    'bigint',
    'decimal',
    'boolean',
    'uuid',
    'date',
    'timestamp',
    'jsonb',
  ] as const) {
    const f = field('value', type, {
      options:
        type === 'decimal'
          ? { precision: 3, scale: 2 }
          : type === 'varchar'
            ? { length: 2 }
            : {},
    });
    const schema = fieldSchema(f);
    validateValue(f, synthetic(schema));
    if (type === 'bigint' || type === 'decimal')
      assert.equal(schema.type, 'string');
    if (type === 'jsonb') {
      assert.deepEqual(schema.not, { type: 'null' });
      for (const v of [[], true, 1, 'text', {}]) validateValue(f, v);
    } else
      assert.ok(
        (fieldSchema({ ...f, nullable: true }).type as string[]).includes(
          'null',
        ),
      );
    assert.throws(() => validateValue(f, null));
    validateValue({ ...f, nullable: true }, null);
  }
});
test('examples match create/PATCH/list and application credential validators', () => {
  const input = snapshot(),
    doc = generate(input, origin),
    resource = input.resources[0]!;
  const definition = {
    schema: 'private_customer_schema',
    name: 'tasks',
    fields: resource.fields!,
  };
  const body = doc.paths['/tasks']!.post!.requestBody!.content[
    'application/json'
  ]!.example as Record<string, unknown>;
  validateBody(
    definition,
    { ...body, owner_id: '00000000-0000-4000-8000-000000000001' },
    true,
  );
  validateBody(
    definition,
    doc.paths['/tasks/{id}']!.patch!.requestBody!.content['application/json']!
      .example,
    false,
  );
  validateList(definition, {
    limit: '25',
    offset: '0',
    direction: 'asc',
    sort: 'title',
    'filter[done]': 'false',
  });
  for (const action of ['signup', 'login'])
    credentials(
      doc.paths[`/auth/${action}`]!.post!.requestBody!.content[
        'application/json'
      ]!.example,
      action === 'signup',
    );
});
test('PATCH excludes owner fields from other policies; defaults stay private; key scopes and disabled operations', () => {
  const input = snapshot(),
    r = input.resources[0]!;
  r.policies.update = { mode: 'key_only' };
  r.policies.create = { mode: 'key_only' };
  r.fields!.push(
    field('secret_default', 'text', {
      default: { kind: 'literal', value: 'default-secret-sentinel' },
    }),
  );
  r.operations = ['list', 'create', 'update'];
  const doc = generate(input, origin);
  assert.ok(!doc.paths['/tasks/{id}']!.get);
  assert.ok(!doc.paths['/tasks/{id}']!.delete);
  assert.match(doc.paths['/tasks/{id}']!.patch!.description, /read_write/);
  assert.deepEqual(doc.paths['/tasks/{id}']!.patch!.security, [
    { ProjectApiKey: [] },
  ]);
  assert.ok(
    !doc.paths['/tasks/{id}']!.patch!.requestBody!.content['application/json']!
      .schema.properties!.owner_id,
  );
  assert.ok(
    doc.paths['/tasks']!.post!.requestBody!.content['application/json']!.schema
      .properties!.owner_id,
  );
  assert.ok(!JSON.stringify(doc).includes('default-secret-sentinel'));
  const params = doc.paths['/tasks']!.get!.parameters!;
  assert.ok(params.some((p) => p.name === 'filter[done]'));
  input.auth!.signupEnabled = false;
  assert.ok(!generate(input, origin).paths['/auth/signup']);
  input.auth!.enabled = false;
  assert.throws(() => generate(input, origin), {
    code: 'API_DOCS_UNAVAILABLE',
  });
  input.workflows = [];
  assert.ok(!generate(input, origin).paths['/auth/login']);
});
test('workflow overlapping branches, 204, dynamic fallback and known references', () => {
  const input = snapshot(),
    w = input.workflows[0]!;
  const branch = w.definition!.steps[0]!;
  assert.equal(branch.type, 'condition');
  if (branch.type !== 'condition') return;
  branch.then = [
    {
      id: 'a',
      name: 'A',
      type: 'response',
      status: 200,
      body: { kind: 'literal', value: { accepted: 'hidden' } },
    },
  ];
  branch.else = [
    {
      id: 'b',
      name: 'B',
      type: 'response',
      status: 200,
      body: {
        kind: 'reference',
        source: 'step',
        stepId: 'db-secret',
        path: ['row'],
      },
    },
  ];
  const schema = generate(input, origin).paths['/place-order']!.post!.responses[
    '200'
  ]!.content!['application/json']!.schema;
  assert.equal(schema.anyOf!.length, 2);
  assert.ok(!JSON.stringify(schema).includes('hidden'));
  assert.match(JSON.stringify(schema), /Dynamic JSON/);
  w.definition!.steps = [
    { id: 'empty', name: 'Empty', type: 'response', status: 204 },
  ];
  assert.ok(
    !generate(input, origin).paths['/place-order']!.post!.responses['204']!
      .content,
  );
  assert.equal(
    infer({ kind: 'reference', source: 'auth', path: ['user', 'id'] }, {})
      .format,
    'uuid',
  );
  assert.equal(infer({ kind: 'literal', value: null }, {}).type, 'null');
  assert.equal(infer({ kind: 'array', items: [] }, {}).type, 'array');
});
test('unresolved deployments and stale workflow dependencies fail closed', () => {
  for (const mutate of [
    (s: DocsSnapshot) => {
      s.blocked = true;
    },
    (s: DocsSnapshot) => {
      s.resources[0]!.fields = null;
    },
    (s: DocsSnapshot) => {
      s.tables[0]!.appliedRevision = 2;
    },
    (s: DocsSnapshot) => {
      s.auth!.provisioningStatus = 'outcome_unknown';
    },
  ]) {
    const input = snapshot();
    mutate(input);
    assert.throws(() => generate(input, origin), {
      statusCode: 503,
      code: 'API_DOCS_UNAVAILABLE',
    });
  }
});
test('HTTP route requires platform auth, owner scopes documents and has no public endpoint', async (t) => {
  const app = buildApp({
    env,
    projectRepository: memoryRepository(),
    platformAuthRepository: memoryPlatformAuthRepository(ownerId),
    logger: false,
    docsRepository: {
      async snapshot(id, owner) {
        return id === ownerId && owner === ownerId ? snapshot() : undefined;
      },
    },
  });
  t.after(() => app.close());
  const url = `/internal/projects/${ownerId}/openapi`;
  assert.equal((await app.inject(url)).statusCode, 401);
  const result = await app.inject({ url, headers: auth });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(String(result.headers['content-type']), /application\/json/);
  assert.equal(
    (
      await app.inject({
        url: '/internal/projects/22222222-2222-4222-8222-222222222222/openapi',
        headers: auth,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject('/api/docs-project/openapi.json')).statusCode,
    404,
  );
});

test('string numeric patterns accept runtime examples rather than escaped backslashes', () => {
  for (const type of ['bigint', 'decimal'] as const) {
    const schema = fieldSchema(
      field('value', type, { options: { precision: 5, scale: 2 } }),
    );
    assert.ok(
      new RegExp(schema.pattern as string).test(
        type === 'bigint' ? '123' : '10.50',
      ),
    );
    assert.ok(!new RegExp(schema.pattern as string).test('not-a-number'));
  }
});

test('generated request/response examples satisfy their OpenAPI JSON Schemas', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // These are the validator's existing dependencies; validation is test-time only.
  const Ajv = require('ajv/dist/2020.js').default;
  const ajv = new Ajv({ strict: false });
  require('ajv-formats')(ajv);
  const input = snapshot();
  input.resources[0]!.fields!.push(
    field('count_exact', 'bigint'),
    field('price', 'decimal', { options: { precision: 3, scale: 2 } }),
  );
  const doc = generate(input, origin);
  for (const methods of Object.values(doc.paths))
    for (const operation of Object.values(methods)) {
      const media = [
        ...Object.values(operation.requestBody?.content ?? {}),
        ...Object.values(operation.responses).flatMap((r) =>
          Object.values(r.content ?? {}),
        ),
      ];
      for (const entry of media)
        if (Object.hasOwn(entry, 'example')) {
          const valid = ajv.compile({
            ...entry.schema,
            components: doc.components,
          });
          assert.ok(
            valid(entry.example),
            `${operation.operationId}: ${JSON.stringify(valid.errors)}`,
          );
        }
    }
});
test('relationship includes validate as bounded optional nonrecursive OpenAPI responses', async () => {
  const input = snapshot();
  const resource = input.resources[0]!;
  resource.includes = [{ name: 'customer_id', referenceName: 'customers', fields: [field('name', 'text')], policy: { mode: 'authenticated' } }];
  const doc = generate(input, origin);
  const validation = await new Validator().validate(doc as unknown as Record<string, unknown>);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  for (const operation of [doc.paths['/tasks']!.get!, doc.paths['/tasks/{id}']!.get!]) {
    const parameter = operation.parameters!.find((candidate) => candidate.name === 'include')!;
    assert.equal(parameter.style, 'form'); assert.equal(parameter.explode, false);
    assert.equal(parameter.schema.maxItems, 2); assert.equal(parameter.schema.uniqueItems, true);
    assert.deepEqual(parameter.schema.items!.enum, ['customer_id']);
    assert.ok(operation.responses['403']);
    const media = operation.responses['200']!.content!['application/json']!;
    assert.ok(media.examples?.ordinary); assert.ok(media.examples?.expanded);
    assert.ok(!JSON.stringify(media.examples.ordinary).includes('_related'));
    assert.ok(JSON.stringify(media.examples.expanded).includes('_related'));
  }
  assert.ok(!doc.paths['/tasks']!.post!.parameters?.some((parameter) => parameter.name === 'include'));
  resource.includes[0]!.policy = { mode: 'key_only' };
  const incompatible = generate(input, origin);
  assert.ok(!incompatible.paths['/tasks/{id}']!.get!.parameters?.some((parameter) => parameter.name === 'include'));
});
