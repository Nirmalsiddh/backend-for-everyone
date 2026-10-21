// Run against git archives of the actual tags; never regenerate fixtures through the current planner.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const base = process.env.V12_HISTORY_DIR;
if (!base) throw new Error('V12_HISTORY_DIR must contain v08/v09/v10/v11 tagged archives');
for (const minor of [8, 9, 10, 11]) {
  const tag = `v0.${minor}.0-alpha.1`;
  const source = `${base}/v${String(minor).padStart(2, '0')}`;
  const { generatePlan } = await import(pathToFileURL(`${source}/backend/src/modules/schema-builder/plan.ts`).href);
  const field = { id: '44444444-4444-4444-8444-444444444444', name: 'value_key', position: 0, type: 'integer', options: {}, nullable: true, unique: false, default: null };
  const target = { projectId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', id: '55555555-5555-4555-8555-555555555555', appliedRevision: 1, appliedPhysicalRevision: 1, appliedDefinition: { definition: { schema: 'history', name: 'parents', fields: [] }, catalog: {} } };
  const table = { id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', schemaName: 'history', name: 'records', draftRevision: 2, appliedRevision: 1, appliedPhysicalRevision: 1, createdAt: new Date(0), updatedAt: new Date(0), fields: [field], appliedDefinition: { definition: { schema: 'history', name: 'records', fields: [field] }, catalog: {} } };
  const scenarios = [
    { name: 'legacy_nullable_add', table: { ...table, fields: [field, { ...field, id: '66666666-6666-4666-8666-666666666666', name: 'notes', position: 1, type: 'text' }] }, tables: [] },
    { name: 'relationships', table: { ...table, fields: [field, { ...field, id: '77777777-7777-4777-8777-777777777777', name: 'parent_id', position: 1, type: 'uuid', relationship: { tableId: target.id, onDelete: 'restrict' } }] }, tables: [target] },
    ...(minor >= 9 ? [
      { name: 'requiredness', table: { ...table, fields: [{ ...field, nullable: false }] }, tables: [] },
      { name: 'normal_index', table: { ...table, indexes: [{ id: '88888888-8888-4888-8888-888888888888', specificationVersion: 1, fieldIds: [field.id], unique: false }] }, tables: [] },
    ] : []),
  ];
  const fixtures = scenarios.map((scenario) => { const plan = generatePlan(scenario.table, scenario.tables); return { ...scenario, hash: plan.hash, version: plan.version ?? 1, definition: plan.definition, statements: plan.statements, ...(plan.evolution ? { evolution: plan.evolution } : {}) }; });
  const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
  await writeFile(`tests/fixtures/schema-history/${tag}.json`, JSON.stringify({ tag, commit, fixtures }, null, 2) + '\n');
}
const oldModule = (minor: number, path: string) => import(pathToFileURL(`${base}/v${minor}/backend/${path}`).href);
const [{ snapshot }, { buildContract }, { render }, { createHash }] = await Promise.all([
  oldModule(11, 'tests/api-docs-fixtures.ts'), oldModule(11, 'src/modules/typescript-client/contract.ts'), oldModule(11, 'src/modules/typescript-client/render.ts'), import('node:crypto'),
]);
const restored = snapshot(); restored.tables[0] = { ...restored.tables[0], name: 'tasks', fields: restored.resources[0].fields };
const contract = buildContract(restored);
await writeFile('tests/fixtures/schema-history/v11-sdk.json', JSON.stringify({ snapshot: restored, contractHash: contract.hash, tableRevisions: contract.tableRevisions, sourceHash: createHash('sha256').update(render(contract)).digest('hex') }, null, 2) + '\n');
const [{ validateList }, { selectList }] = await Promise.all([oldModule(10, 'src/runtime/validation.ts'), oldModule(10, 'src/runtime/queries.ts')]);
const definition = { schema: 'history', name: 'records', fields: [
  { id: '44444444-4444-4444-8444-444444444444', name: 'exact_value', position: 0, type: 'bigint', options: {}, nullable: true, unique: false, default: null },
  { id: '55555555-5555-4555-8555-555555555555', name: 'moment_value', position: 1, type: 'timestamp', options: {}, nullable: true, unique: false, default: null },
] };
const queries = [ { 'filter[exact_value][gte]': '9007199254740993', sort: 'exact_value', direction: 'desc', limit: '10' }, { 'filter[moment_value][lte]': '2024-02-29T23:59:59.123456+05:30' }, { 'filter[exact_value][is_null]': 'true' } ];
await writeFile('tests/fixtures/schema-history/v10-query.json', JSON.stringify({ definition, cases: queries.map((query) => { const options = validateList(definition, query); return { query, options, compiled: selectList(definition, options) }; }) }, null, 2) + '\n');
