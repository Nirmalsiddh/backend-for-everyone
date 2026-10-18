import { CredentialEncryption } from '../../security/encryption.js';
import type { ConnectionConfig } from '../database-connections/types.js';
import { verifySessionGuard } from '../../database/customer-db/auth-store.js';
import { catalog } from '../../database/customer-db/catalog.js';
import {
  TransactionAbort,
  type CustomerTransactionRunner,
} from '../../database/customer-db/transaction-runner.js';
import type { RuntimePrincipal } from '../../runtime/types.js';
import {
  RuntimeError,
  badRequest,
  notFound,
  unauthorized,
  unavailable,
} from '../../runtime/errors.js';
import { ownerColumn } from '../../runtime/authorization.js';
import {
  validateBody,
  validateId,
  validateValue,
} from '../../runtime/validation.js';
import { canonical, quoteIdentifier as q } from '../schema-builder/plan.js';
import {
  boundedJson,
  executionError,
  object,
  resolveValue,
  type Context,
} from './values.js';
import { inspectWorkflow } from './validation.js';
import {
  projectRow,
  workflowDelete,
  workflowField,
  workflowInsert,
  workflowQuery,
  workflowUpdate,
} from './queries.js';
import type {
  InputField,
  Step,
  WorkflowRepository,
  WorkflowResult,
} from './types.js';
function inputBody(input: Record<string, InputField>, body: unknown) {
  if (
    !object(body) ||
    Object.keys(body).some((key) => !Object.hasOwn(input, key))
  )
    throw badRequest();
  for (const [name, rule] of Object.entries(input)) {
    if (!Object.hasOwn(body, name)) {
      if (rule.required) throw badRequest();
      continue;
    }
    const value = body[name];
    if (value === null) {
      if (!rule.nullable) throw badRequest();
      continue;
    }
    if (rule.type === 'uuid') {
      if (typeof value !== 'string') throw badRequest();
      validateId(value);
    } else if (rule.type === 'string') {
      if (
        typeof value !== 'string' ||
        [...value].length < (rule.minLength ?? 0) ||
        [...value].length > (rule.maxLength ?? 10000)
      )
        throw badRequest();
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') throw badRequest();
    } else if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < Math.max(-2147483648, rule.min ?? -2147483648) ||
      value > Math.min(2147483647, rule.max ?? 2147483647)
    )
      throw badRequest();
  }
  return body;
}
export function compare(operator: string, left: unknown, right?: unknown) {
  if (operator === 'is_null') return left === null;
  if (operator === 'is_not_null') return left !== null;
  if (
    left === null ||
    right === null ||
    typeof left !== typeof right ||
    !['string', 'number', 'boolean'].includes(typeof left)
  )
    throw executionError();
  if (operator === 'equals') return left === right;
  if (operator === 'not_equals') return left !== right;
  if (
    typeof left !== 'number' ||
    typeof right !== 'number' ||
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right)
  )
    throw executionError();
  if (operator === 'greater_than') return left > right;
  if (operator === 'greater_or_equal') return left >= right;
  if (operator === 'less_than') return left < right;
  if (operator === 'less_or_equal') return left <= right;
  throw executionError();
}
export class WorkflowEngine {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly encryption: CredentialEncryption,
    private readonly runner: CustomerTransactionRunner,
  ) {}
  async execute(
    principal: RuntimePrincipal,
    path: string,
    body: unknown,
    query: Record<string, unknown>,
  ): Promise<WorkflowResult | undefined> {
    const target = await this.repository.resolve(principal.projectId, path);
    if (!target) return undefined;
    if (target.blocked) throw unavailable();
    const definition = target.version.definition;
    const isUser = 'kind' in principal && principal.kind === 'user';
    if ((definition.auth === 'authenticated') !== isUser) throw unauthorized();
    const inspected = inspectWorkflow(
      definition,
      target.tables,
      target.connection.id,
    );
    if (
      'scope' in principal &&
      principal.scope === 'read' &&
      inspected.requiredScope === 'read_write'
    )
      throw new RuntimeError(
        403,
        'INSUFFICIENT_SCOPE',
        'API key does not permit workflow writes',
      );
    for (const dependency of target.version.schemaDependencies)
      if (
        !target.tables.some(
          (table) =>
            table.id === dependency.tableId &&
            table.appliedRevision === dependency.appliedRevision,
        )
      )
        throw unavailable();
    if (Object.keys(query).length) throw badRequest();
    const context: Context = {
      request: {
        body: inputBody(definition.input, body),
        query: {},
        params: {},
      },
      auth: isUser
        ? { user: { id: principal.userId, role: principal.role } }
        : {},
      steps: Object.create(null) as Record<string, unknown>,
      variables: {},
    };
    const connection = target.connection;
    const config = this.encryption.decrypt<ConnectionConfig>(
      connection,
      `${connection.projectId}:${connection.id}`,
    );
    if (isUser && principal.context.connection.id !== connection.id)
      throw unavailable();
    return this.runner(config, async (client) => {
      if (isUser)
        await verifySessionGuard(client, config.schema, {
          context: principal.context,
          tokenHash: principal.tokenHash,
          userId: principal.userId,
          role: principal.role,
        });
      for (const dependency of [...target.version.schemaDependencies].sort(
        (a, b) => a.tableId.localeCompare(b.tableId),
      )) {
        const applied = target.tables.find(
          (table) => table.id === dependency.tableId,
        )?.appliedDefinition;
        if (!applied || applied.definition.schema !== config.schema)
          throw unavailable();
        await client.query(
          `LOCK TABLE ONLY ${q(config.schema)}.${q(applied.definition.name)} IN ACCESS SHARE MODE`,
        );
        if (
          canonical(
            await catalog(client, config.schema, applied.definition.name),
          ) !== canonical(applied.catalog)
        )
          throw unavailable();
      }
      let dbOperations = 0;
      const walk = async (
        steps: Step[],
      ): Promise<WorkflowResult | undefined> => {
        for (const step of steps) {
          if (step.type === 'response') {
            const response = step.body
              ? resolveValue(step.body, context)
              : null;
            try {
              boundedJson(response, 262144);
            } catch {
              throw executionError();
            }
            const result: WorkflowResult = {
              status: step.status,
              body: response,
              workflowId: target.endpoint.id,
              versionId: target.version.id,
              stepCount: inspected.stepCount,
              dbOperations,
              terminalStepId: step.id,
              outcome: step.status >= 400 ? 'rollback' : 'commit',
            };
            if (step.status >= 400) throw new TransactionAbort(result);
            return result;
          }
          if (step.type === 'condition') {
            const outcome = compare(
              step.operator,
              resolveValue(step.left, context),
              step.right ? resolveValue(step.right, context) : undefined,
            );
            const result = await walk(outcome ? step.then : step.else);
            if (result) return result;
            continue;
          }
          const applied = target.tables.find(
            (table) => table.id === step.tableId,
          )?.appliedDefinition;
          if (!applied) throw unavailable();
          const schema = applied.definition;
          const column = ownerColumn(schema, step.access);
          const owner =
            column &&
            isUser &&
            !(
              step.access.mode === 'owner' &&
              step.access.allowAdmin &&
              principal.role === 'admin'
            )
              ? { field: column, userId: principal.userId }
              : undefined;
          const id =
            step.type === 'insert'
              ? undefined
              : resolveValue(step.idValue, context);
          if (step.type !== 'insert') {
            if (typeof id !== 'string') throw executionError();
            try {
              validateId(id);
            } catch {
              throw executionError();
            }
          }
          let compiled;
          if (step.type === 'query')
            compiled = workflowQuery(
              schema,
              id as string,
              step.select,
              owner,
              step.forUpdate ?? false,
            );
          else if (step.type === 'delete')
            compiled = workflowDelete(schema, id as string, owner);
          else if (step.type === 'insert') {
            const values = Object.fromEntries(
              Object.entries(step.values).map(([fieldId, value]) => [
                workflowField(schema, fieldId).name,
                resolveValue(value, context),
              ]),
            );
            if (column && isUser) values[column] = principal.userId;
            try {
              validateBody(schema, values, true);
            } catch {
              throw executionError();
            }
            compiled = workflowInsert(schema, values, step.select);
          } else {
            const assignments = step.assignments.map((assignment) => {
              const field = workflowField(schema, assignment.fieldId);
              const value = resolveValue(assignment.value, context);
              try {
                validateValue(field, value);
              } catch {
                throw executionError();
              }
              if (
                assignment.operation === 'decrement' &&
                (typeof value !== 'number' ||
                  !Number.isInteger(value) ||
                  value <= 0)
              )
                throw executionError();
              return {
                fieldId: assignment.fieldId,
                operation: assignment.operation,
                value,
              };
            });
            compiled = workflowUpdate(
              schema,
              id as string,
              assignments,
              step.select,
              owner,
            );
          }
          dbOperations++;
          const [row] = (await client.query(compiled.text, compiled.values))
            .rows;
          if (!row && (step.type !== 'query' || step.onMissing === '404')) {
            const status = step.type === 'update' ? step.onNoMatch : 404;
            if (status === 404) throw notFound();
            throw new RuntimeError(
              status,
              'WORKFLOW_REJECTED',
              'Workflow operation could not be completed',
            );
          }
          context.steps[step.id] =
            step.type === 'delete'
              ? { id: row!.id }
              : { row: row ? projectRow(row, step.select) : null };
          try {
            boundedJson(context, 524288);
          } catch {
            throw executionError();
          }
        }
        return undefined;
      };
      const result = await walk(definition.steps);
      if (!result) throw executionError();
      return result;
    });
  }
}
