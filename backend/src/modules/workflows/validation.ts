import {
  workflowAuthModes,
  comparisonOperators,
  responseStatuses,
  workflowStepKinds,
} from '../../../../shared/public-contracts.js';
import {
  workflowQuery,
  workflowInsert,
  workflowUpdate,
  workflowDelete,
  workflowField,
} from './queries.js';
import { ownerColumn } from '../../runtime/authorization.js';
import { createHash } from 'node:crypto';
import { uuidPattern } from '../../config/env.js';
import { canonical } from '../schema-builder/plan.js';
import { invalid } from '../schema-builder/errors.js';
import { validatePolicies } from '../../runtime/authorization.js';
import { forbidden, keys, boundedJson, object } from './values.js';
import type {
  Step,
  Value,
  WorkflowDefinition,
  WorkflowPreview,
  WorkflowTable,
} from './types.js';
export function validatePath(path: string) {
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(path) ||
    path.length > 63 ||
    path === 'auth' ||
    /^(pg|sql|platform|internal|schema)(-|$)/.test(path)
  )
    throw invalid('Workflow path must be a non-reserved lowercase URL slug');
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && new RegExp(uuidPattern).test(value);
export function inspectWorkflow(
  definition: WorkflowDefinition,
  tables?: WorkflowTable[],
  connectionId?: string,
): Omit<WorkflowPreview, 'definitionHash' | 'draftRevision'> {
  boundedJson(definition, 65536);
  if (!object(definition)) throw invalid('Invalid workflow document');
  keys(definition, ['input', 'auth', 'steps']);
  if (
    !object(definition.input) ||
    !workflowAuthModes.some((mode) => mode === definition.auth) ||
    !Array.isArray(definition.steps)
  )
    throw invalid('Invalid workflow document');
  if (Object.keys(definition.input).length > 100)
    throw invalid('Too many workflow input fields');
  for (const [name, field] of Object.entries(definition.input)) {
    if (
      !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
      forbidden.has(name) ||
      !object(field)
    )
      throw invalid('Invalid input field');
    keys(field, [
      'type',
      'required',
      'nullable',
      'min',
      'max',
      'minLength',
      'maxLength',
    ]);
    if (
      !['uuid', 'string', 'integer', 'boolean'].includes(field.type) ||
      ['required', 'nullable'].some(
        (key) =>
          Object.hasOwn(field, key) &&
          typeof field[key as 'required'] !== 'boolean',
      )
    )
      throw invalid('Invalid input rule');
    for (const key of ['min', 'max', 'minLength', 'maxLength'] as const)
      if (field[key] !== undefined && !Number.isSafeInteger(field[key]))
        throw invalid('Invalid input bound');
    if (
      (field.min !== undefined || field.max !== undefined) &&
      field.type !== 'integer'
    )
      throw invalid('Numeric bounds require integer input');
    if (
      (field.minLength !== undefined || field.maxLength !== undefined) &&
      field.type !== 'string'
    )
      throw invalid('Length bounds require string input');
    if (
      (field.minLength ?? 0) < 0 ||
      (field.maxLength ?? 10000) > 10000 ||
      (field.minLength ?? 0) > (field.maxLength ?? 10000) ||
      (field.min ?? -2147483648) > (field.max ?? 2147483647)
    )
      throw invalid('Invalid input bounds');
  }
  let stepCount = 0;
  let databaseStepCount = 0;
  let writes = false;
  const ids = new Set<string>();
  const names = new Set<string>();
  const dependencyIds = new Set<string>();
  const operations: WorkflowPreview['operations'] = [];
  // Step outputs contain only explicitly selected field-ID keys plus optional implicit id.
  const value = (
    item: Value,
    available: Map<string, Set<string>>,
    depth = 0,
  ): void => {
    if (!object(item) || depth > 15) throw invalid('Invalid workflow value');
    if (item.kind === 'literal') {
      keys(item, ['kind', 'value']);
      if (!Object.hasOwn(item, 'value')) throw invalid('Missing literal');
      boundedJson(item.value, 32768);
      return;
    }
    if (item.kind === 'object') {
      keys(item, ['kind', 'fields']);
      if (!object(item.fields)) throw invalid('Invalid object mapping');
      for (const [key, child] of Object.entries(item.fields)) {
        if (forbidden.has(key)) throw invalid('Invalid mapping key');
        value(child, available, depth + 1);
      }
      return;
    }
    if (item.kind === 'array') {
      keys(item, ['kind', 'items']);
      if (!Array.isArray(item.items)) throw invalid('Invalid array mapping');
      item.items.forEach((child) => value(child, available, depth + 1));
      return;
    }
    if (item.kind !== 'reference') throw invalid('Unsupported value kind');
    keys(item, ['kind', 'source', 'stepId', 'path']);
    if (
      !Array.isArray(item.path) ||
      !item.path.length ||
      item.path.length > 3 ||
      item.path.some((key) => typeof key !== 'string' || forbidden.has(key))
    )
      throw invalid('Invalid reference path');
    if (item.source === 'request') {
      if (
        Object.hasOwn(item, 'stepId') ||
        item.path.length !== 2 ||
        item.path[0] !== 'body' ||
        !Object.hasOwn(definition.input, item.path[1]!)
      )
        throw invalid('Invalid request reference');
    } else if (item.source === 'auth') {
      if (
        Object.hasOwn(item, 'stepId') ||
        definition.auth !== 'authenticated' ||
        item.path.length !== 2 ||
        item.path[0] !== 'user' ||
        !['id', 'role'].includes(item.path[1]!)
      )
        throw invalid('Invalid auth reference');
    } else if (item.source === 'step') {
      const fields = available.get(item.stepId);
      if (
        !fields ||
        (item.path[0] === 'row'
          ? !fields.has('$row') ||
            item.path.length > 2 ||
            (item.path.length === 2 && !fields.has(item.path[1]!))
          : fields.has('$row') ||
            item.path[0] !== 'id' ||
            item.path.length !== 1 ||
            !fields.has(item.path[0]!))
      )
        throw invalid('Unavailable step reference');
    } else throw invalid('Unsupported reference source');
  };
  const walk = (
    steps: Step[],
    incoming: Map<string, Set<string>>,
    depth: number,
  ): boolean => {
    if (!Array.isArray(steps) || depth > 3)
      throw invalid('Condition nesting exceeds limit');
    const available = new Map(incoming);
    let terminated = false;
    for (const step of steps) {
      if (terminated) throw invalid('Unreachable workflow step');
      if (
        !object(step) ||
        !uuid(step.id) ||
        typeof step.name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(step.name) ||
        ids.has(step.id) ||
        names.has(step.name)
      )
        throw invalid('Invalid or duplicate step identity');
      ids.add(step.id);
      names.add(step.name);
      if (++stepCount > 30) throw invalid('Too many workflow steps');
      if (step.type === 'response') {
        keys(step, ['id', 'name', 'type', 'status', 'body']);
        if (
          !responseStatuses.some((status) => status === step.status) ||
          (step.status === 204 && Object.hasOwn(step, 'body')) ||
          (step.status !== 204 && !Object.hasOwn(step, 'body'))
        )
          throw invalid('Invalid workflow response');
        if (step.body) value(step.body, available);
        terminated = true;
        continue;
      }
      if (step.type === 'condition') {
        keys(step, [
          'id',
          'name',
          'type',
          'operator',
          'left',
          'right',
          'then',
          'else',
        ]);
        if (!comparisonOperators.some((operator) => operator === step.operator))
          throw invalid('Invalid comparison operator');
        value(step.left, available);
        if (['is_null', 'is_not_null'].includes(step.operator)) {
          if (Object.hasOwn(step, 'right'))
            throw invalid('Null comparison has one operand');
        } else {
          if (!step.right) throw invalid('Missing comparison operand');
          value(step.right, available);
        }
        const yes = walk(step.then, available, depth + 1);
        const no = walk(step.else, available, depth + 1);
        terminated = yes && no;
        continue;
      }
      if (!workflowStepKinds.some((kind) => kind === step.type))
        throw invalid('Unsupported workflow block');
      if (++databaseStepCount > 10 || !uuid(step.tableId))
        throw invalid('Invalid database step');
      dependencyIds.add(step.tableId);
      if (dependencyIds.size > 5) throw invalid('Too many workflow tables');
      const table = tables?.find((candidate) => candidate.id === step.tableId);
      const applied = table?.appliedDefinition?.definition;
      if (
        tables &&
        (!table ||
          !applied ||
          table.appliedRevision === null ||
          table.connectionId !== connectionId ||
          /^(platform_|internal_|pg_|schema_)/.test(applied.name))
      )
        throw invalid(
          'Workflow requires an applied managed table on its connection',
        );
      const access = step.access;
      if (
        !object(access) ||
        (definition.auth === 'key_only'
          ? access.mode !== 'key_only'
          : !['authenticated', 'owner'].includes(access.mode))
      )
        throw invalid(
          'Database access policy does not match workflow authentication',
        );
      if (applied) validatePolicies({ get: access }, applied);
      else if (access.mode === 'owner') {
        keys(access, ['mode', 'ownerFieldId', 'allowAdmin']);
        if (
          !uuid(access.ownerFieldId) ||
          typeof access.allowAdmin !== 'boolean'
        )
          throw invalid('Invalid owner policy');
      } else keys(access, ['mode']);
      const selected = new Set<string>();
      const fieldExists = (fieldId: string) =>
        fieldId === 'id' ||
        (uuid(fieldId) &&
          (!applied || applied.fields.some((field) => field.id === fieldId)));
      if (step.type !== 'delete') {
        if (
          !Array.isArray(step.select) ||
          step.select.length > 101 ||
          new Set(step.select).size !== step.select.length ||
          step.select.some((id) => !fieldExists(id))
        )
          throw invalid('Invalid selected fields');
        step.select.forEach((id) => selected.add(id));
        selected.add('$row');
      }
      if (step.type === 'query') {
        keys(step, [
          'id',
          'name',
          'type',
          'tableId',
          'access',
          'select',
          'idValue',
          'forUpdate',
          'onMissing',
        ]);
        if (
          !['null', '404'].includes(step.onMissing) ||
          (step.forUpdate !== undefined && typeof step.forUpdate !== 'boolean')
        )
          throw invalid('Invalid query configuration');
        value(step.idValue, available);
      } else if (step.type === 'insert') {
        keys(step, [
          'id',
          'name',
          'type',
          'tableId',
          'access',
          'select',
          'values',
        ]);
        if (!object(step.values)) throw invalid('Invalid insert mapping');
        for (const [id, item] of Object.entries(step.values)) {
          if (
            id === 'id' ||
            !fieldExists(id) ||
            (access.mode === 'owner' && access.ownerFieldId === id)
          )
            throw invalid('Invalid insert field');
          value(item, available);
        }
        if (applied)
          for (const field of applied.fields)
            if (
              !field.nullable &&
              !field.default &&
              !Object.hasOwn(step.values, field.id) &&
              !(access.mode === 'owner' && access.ownerFieldId === field.id)
            )
              throw invalid('Missing required insert mapping');
        writes = true;
      } else if (step.type === 'update') {
        keys(step, [
          'id',
          'name',
          'type',
          'tableId',
          'access',
          'select',
          'idValue',
          'assignments',
          'onNoMatch',
        ]);
        value(step.idValue, available);
        if (
          ![404, 409, 422].includes(step.onNoMatch) ||
          !Array.isArray(step.assignments) ||
          !step.assignments.length ||
          step.assignments.length > 100
        )
          throw invalid('Invalid update');
        const assigned = new Set<string>();
        for (const assignment of step.assignments) {
          if (!object(assignment)) throw invalid('Invalid assignment');
          keys(assignment, ['operation', 'fieldId', 'value', 'guard']);
          if (
            !['set', 'decrement'].includes(assignment.operation) ||
            assignment.fieldId === 'id' ||
            !fieldExists(assignment.fieldId) ||
            assigned.has(assignment.fieldId) ||
            (access.mode === 'owner' &&
              access.ownerFieldId === assignment.fieldId)
          )
            throw invalid('Invalid assignment field');
          assigned.add(assignment.fieldId);
          value(assignment.value, available);
          if (assignment.operation === 'decrement') {
            if (
              assignment.guard !== 'gte_value' ||
              (applied &&
                !applied.fields.some(
                  (field) =>
                    field.id === assignment.fieldId && field.type === 'integer',
                ))
            )
              throw invalid(
                'Decrement requires an integer field and gte_value guard',
              );
          } else if (Object.hasOwn(assignment, 'guard'))
            throw invalid('Set does not accept a guard');
        }
        writes = true;
      } else {
        keys(step, ['id', 'name', 'type', 'tableId', 'access', 'idValue']);
        value(step.idValue, available);
        selected.add('id');
        writes = true;
      }
      let sqlTemplate: string | undefined;
      if (applied) {
        const placeholderId = '00000000-0000-0000-0000-000000000000';
        const owner = ownerColumn(applied, access);
        const ownership = owner
          ? { field: owner, userId: placeholderId }
          : undefined;
        if (step.type === 'query')
          sqlTemplate = workflowQuery(
            applied,
            placeholderId,
            step.select,
            ownership,
            step.forUpdate ?? false,
          ).text;
        else if (step.type === 'delete')
          sqlTemplate = workflowDelete(applied, placeholderId, ownership).text;
        else if (step.type === 'update')
          sqlTemplate = workflowUpdate(
            applied,
            placeholderId,
            step.assignments.map((assignment) => ({
              fieldId: assignment.fieldId,
              operation: assignment.operation,
              value: null,
            })),
            step.select,
            ownership,
          ).text;
        else {
          const fields = Object.fromEntries(
            Object.keys(step.values).map((id) => [
              workflowField(applied, id).name,
              null,
            ]),
          );
          if (owner) fields[owner] = null;
          sqlTemplate = workflowInsert(applied, fields, step.select).text;
        }
      }
      operations.push({
        stepId: step.id,
        type: step.type,
        tableId: step.tableId,
        access,
        ...(sqlTemplate ? { sqlTemplate } : {}),
      });
      available.set(step.id, selected);
    }
    return terminated;
  };
  if (!walk(definition.steps, new Map(), 0))
    throw invalid('Every workflow path must terminate with a Response');
  return {
    requiredScope: writes ? 'read_write' : 'read',
    stepCount,
    databaseStepCount,
    operations,
    schemaDependencies: [...dependencyIds]
      .sort()
      .map((tableId) => ({
        tableId,
        appliedRevision:
          tables?.find((table) => table.id === tableId)?.appliedRevision ?? 0,
      })),
  };
}
export function previewWorkflow(
  definition: WorkflowDefinition,
  revision: number,
  tables: WorkflowTable[],
  connectionId: string,
): WorkflowPreview {
  const inspected = inspectWorkflow(definition, tables, connectionId);
  const definitionHash = createHash('sha256')
    .update(
      canonical({
        definition,
        dependencies: inspected.schemaDependencies,
        connectionId,
      }),
    )
    .digest('hex');
  return { ...inspected, draftRevision: revision, definitionHash };
}
