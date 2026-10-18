import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaTableDto } from '../src/modules/schema-builder/dto.js';
import type { TableRecord } from '../src/modules/schema-builder/types.js';
test('management schema DTO omits private catalog and includes safe recorded outcome', () => {
  const record = {
    id: 'table',
    projectId: 'project',
    connectionId: 'connection',
    schemaName: 'public',
    name: 'items',
    draftRevision: 1,
    appliedRevision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    fields: [],
    appliedDefinition: {
      definition: { schema: 'public', name: 'items', fields: [] },
      catalog: { secret: 'private database internals' },
    },
    applyStatus: {
      status: 'failed',
      migrationId: 'migration',
      errorCode: 'SCHEMA_APPLY_FAILED',
      completedAt: null,
    },
  } satisfies TableRecord;
  const dto = schemaTableDto(record);
  assert.ok(!JSON.stringify(dto).includes('catalog'));
  assert.ok(!JSON.stringify(dto).includes('private database internals'));
  assert.equal(dto.applyStatus?.status, 'failed');
});
