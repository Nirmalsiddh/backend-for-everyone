import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { generateLegacyPlan, canonical } from '../src/modules/schema-builder/plan.js';
import { generateEvolutionPlan } from '../src/modules/schema-builder/evolution.js';
import type { TableRecord, ManagedTable } from '../src/modules/schema-builder/types.js';
for (const minor of [8, 9, 10, 11]) test(`actual tagged v0.${minor} plan formats remain byte-for-byte frozen`, async () => {
  const fixture = JSON.parse(await readFile(new URL(`./fixtures/schema-history/v0.${minor}.0-alpha.1.json`, import.meta.url), 'utf8'));
  assert.match(fixture.commit, /^[0-9a-f]{40}$/);
  for (const item of fixture.fixtures) {
    const plan = (item.version === 3 ? generateEvolutionPlan : generateLegacyPlan)(item.table as TableRecord, item.tables as ManagedTable[]);
    assert.equal(plan.hash, item.hash, item.name);
    assert.equal(canonical(plan.definition), canonical(item.definition));
    assert.deepEqual(plan.statements, item.statements);
    if (item.version === 3) assert.equal(canonical(plan.evolution), canonical(item.evolution));
  }
});
test('actual v0.10 restored applied metadata preserves advanced-query precision and compilation', async () => {
  const { validateList } = await import('../src/runtime/validation.js');
  const { selectList } = await import('../src/runtime/queries.js');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/schema-history/v10-query.json', import.meta.url), 'utf8'));
  for (const item of fixture.cases) {
    const options = validateList(fixture.definition, item.query);
    assert.deepEqual(options, item.options); assert.deepEqual(selectList(fixture.definition, options), item.compiled);
  }
});
test('actual v0.11 restored SDK snapshot retains public hash, table provenance and byte-identical source', async () => {
  const { createHash } = await import('node:crypto');
  const { buildContract } = await import('../src/modules/typescript-client/contract.js');
  const { render } = await import('../src/modules/typescript-client/render.js');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/schema-history/v11-sdk.json', import.meta.url), 'utf8'));
  const contract = buildContract(fixture.snapshot);
  assert.equal(contract.hash, fixture.contractHash); assert.deepEqual(contract.tableRevisions, fixture.tableRevisions);
  assert.equal(createHash('sha256').update(render(contract)).digest('hex'), fixture.sourceHash);
});

test('actual tagged v0.12 v4 plans and SDK output remain frozen', async () => {
  const { generatePlan } = await import('../src/modules/schema-builder/plan.js');
  const { buildContract } = await import('../src/modules/typescript-client/contract.js');
  const { render } = await import('../src/modules/typescript-client/render.js');
  const { createHash } = await import('node:crypto');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/schema-history/v0.12.0-alpha.1.json', import.meta.url), 'utf8'));
  assert.equal(fixture.commit,'7dcf6fd8116b1fd605aa530dfb40309572278dd7');
  for (const item of fixture.fixtures) assert.equal(canonical(generatePlan(item.table,[])),canonical(item.plan),item.name);
  const contract = buildContract(fixture.sdk.snapshot);
  assert.equal(contract.hash,fixture.sdk.hash);
  assert.equal(createHash('sha256').update(render(contract)).digest('hex'),fixture.sdk.sourceHash);
});
