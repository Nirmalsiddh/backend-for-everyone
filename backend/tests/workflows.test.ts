import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inspectWorkflow, previewWorkflow, validatePath } from '../src/modules/workflows/validation.js';
import { resolveValue } from '../src/modules/workflows/values.js';
import { compare } from '../src/modules/workflows/engine.js';
import type { Step, Value, WorkflowDefinition, WorkflowTable } from '../src/modules/workflows/types.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import { workflowUpdate } from '../src/modules/workflows/queries.js';
const literal = (value: unknown): Value => ({ kind: 'literal', value });
const response = (name: string, status: 200 | 409 = 200): Step => ({ id: randomUUID(), name, type: 'response', status, body: literal({ ok: true }) });
const basic = (): WorkflowDefinition => ({ input: {}, auth: 'key_only', steps: [response('done')] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
test('workflow paths are single lowercase non-reserved literal slugs', () => {
  for (const path of ['place-order', 'checkout2', 'products']) assert.doesNotThrow(() => validatePath(path));
  for (const path of ['auth', 'platform-test', 'pg-test', 'Place-order', 'a/b', ':id', '*', 'a%2fb', 'a_b', '-x', 'x-','x'.repeat(64)]) assert.throws(() => validatePath(path));
});
test('static validation enforces structure, auth, response paths, step/depth limits, and no executable forms', () => {
  for (const patch of [{ auth: 'public' }, { steps: [] }, { steps: [{ ...response('done'), status: 302 }] }, { steps: [{ ...response('done'), status: 204 }] }, { steps: [{ id: randomUUID(), name: 'code', type: 'javascript', code: 'return 1' }] }, { input: { x: { type: 'string', regex: '.*' } } }]) {
    assert.throws(() => inspectWorkflow({ ...basic(), ...patch } as WorkflowDefinition));
  }
  const nested = (depth: number): Step => depth ? { id: randomUUID(), name: `condition_${depth}`, type: 'condition', operator: 'equals', left: literal(true), right: literal(true), then: [nested(depth - 1)], else: [response(`else_${depth}`)] } : response('last');
  assert.doesNotThrow(() => inspectWorkflow({ ...basic(), steps: [nested(3)] }));
  assert.throws(() => inspectWorkflow({ ...basic(), steps: [nested(4)] }));
  const many: Step[] = Array.from({ length: 16 }, (_, index) => ({ id: randomUUID(), name: `condition_${index}`, type: 'condition', operator: 'is_null', left: literal(null), then: [response(`branch_${index}`)], else: [] }));
  assert.throws(() => inspectWorkflow({ ...basic(), steps: [...many, response('final')] }));
  const noElse: Step = { id: randomUUID(), name: 'branch', type: 'condition', operator: 'equals', left: literal(1), right: literal(1), then: [response('true')], else: [] };
  assert.throws(() => inspectWorkflow({ ...basic(), steps: [noElse] }));
});
test('references are structural, own-property-only, scoped to selected prior outputs and declared request values', () => {
  const tableId = randomUUID(); const stepId = randomUUID();
  const query: Step = { id: stepId, name: 'lookup', type: 'query', tableId, select: ['id'], idValue: literal(randomUUID()), onMissing: 'null', access: { mode: 'key_only' } };
  const ref: Value = { kind: 'reference', source: 'step', stepId, path: ['row', 'id'] };
  const definition = { ...basic(), steps: [query, { ...response('done'), body: ref }] } as WorkflowDefinition;
  assert.doesNotThrow(() => inspectWorkflow(definition));
  const invalidRefs: Value[] = [ { kind: 'reference', source: 'step', stepId: randomUUID(), path: ['row'] }, { ...ref, path: ['row', 'unknown'] },
    { kind: 'reference', source: 'request', path: ['body', 'undeclared'] }, { kind: 'reference', source: 'auth', path: ['user', 'id'] }, { ...ref, path: ['__proto__'] }, { ...ref, path: ['id'] } ];
  for (const invalid of invalidRefs) assert.throws(() => inspectWorkflow({ ...definition, steps: [query, { ...response('done'), body: invalid }] } as WorkflowDefinition));
  assert.throws(() => inspectWorkflow({ ...definition, steps: [{ id: randomUUID(), name: 'branch', type: 'condition', operator: 'is_null', left: literal(null), then: [query], else: [] }, { ...response('done'), body: ref }] } as WorkflowDefinition));
  const context = { request: { body: { value: 7 }, query: {}, params: {} }, auth: {}, steps: {}, variables: {} };
  assert.equal(resolveValue({ kind: 'reference', source: 'request', path: ['body', 'value'] }, context), 7);
  assert.throws(() => resolveValue({ kind: 'reference', source: 'request', path: ['body', 'toString'] }, context), { statusCode: 500 });
  assert.equal(resolveValue(literal('{{request.body.value}}'), context), '{{request.body.value}}');
});
test('preview hashes bind applied dependencies; writes in either branch require read_write', () => {
  const connectionId = randomUUID(); const tableId = randomUUID(); const draft = normalizeDraft({ name: 'products', fields: [{ name: 'stock', type: 'integer' }] });
  const table: WorkflowTable = { id: tableId, connectionId, appliedRevision: 1, appliedDefinition: { definition: { schema: 'public', ...draft }, catalog: {} } };
  const update: Step = { id: randomUUID(), name: 'decrement', type: 'update', tableId, access: { mode: 'key_only' }, idValue: literal(randomUUID()), select: ['id'], onNoMatch: 409,
    assignments: [{ fieldId: draft.fields[0]!.id, operation: 'decrement', value: literal(1), guard: 'gte_value' }] };
  const definition: WorkflowDefinition = { input: {}, auth: 'key_only', steps: [{ id: randomUUID(), name: 'condition', type: 'condition', operator: 'equals', left: literal(true), right: literal(false), then: [update], else: [] }, response('done')] };
  const first = previewWorkflow(definition, 1, [table], connectionId);
  assert.equal(first.requiredScope, 'read_write'); assert.equal(first.definitionHash, previewWorkflow(clone(definition), 1, [table], connectionId).definitionHash);
  assert.notEqual(first.definitionHash, previewWorkflow(definition, 1, [{ ...table, appliedRevision: 2 }], connectionId).definitionHash);
  assert.throws(() => previewWorkflow(definition, 1, [{ ...table, appliedDefinition: { ...table.appliedDefinition!, definition: { ...table.appliedDefinition!.definition, name: 'platform_auth_users' } } }], connectionId));
  assert.throws(() => previewWorkflow(definition, 1, [table], randomUUID()));
  const sql = workflowUpdate(table.appliedDefinition!.definition, randomUUID(), [{ fieldId: draft.fields[0]!.id, operation: 'decrement', value: 2 }], ['id']);
  assert.match(sql.text, /"stock" = "stock" - \$2::pg_catalog.int4/); assert.match(sql.text, /AND "stock" >= \$2::pg_catalog.int4/);
});
test('conditions never coerce values or compare exact numeric strings as numbers', () => {
  assert.equal(compare('greater_or_equal', 3, 2), true); assert.equal(compare('equals', '3', '3'), true);
  assert.equal(compare('is_null', null), true);
  for (const [left, right] of [['3', 3], ['9223372036854775807', '2'], [null, null], [{}, {}]]) assert.throws(() => compare('greater_than', left, right), { statusCode: 500 });
});
