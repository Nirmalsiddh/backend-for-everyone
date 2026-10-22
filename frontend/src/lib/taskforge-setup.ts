import { api, ApiError } from './api';
import type { Connection, Endpoint, Field, Operation, Project, Table } from './contracts';
import { taskActions, type GuidedState } from './taskforge';

export const taskDraft: { name: string; fields: Field[] } = {
  name: 'tasks',
  fields: [
    { name: 'title', type: 'text', nullable: false },
    { name: 'description', type: 'text', nullable: true },
    { name: 'completed', type: 'boolean', nullable: false, default: { kind: 'literal', value: false } },
    { name: 'due_date', type: 'date', nullable: true },
  ],
};
const mapping: Record<keyof GuidedState['actions'], Operation[]> = {
  create: ['create'], view: ['list', 'get'], edit: ['update'], delete: ['delete'],
};
export function selectedOperations(actions: GuidedState['actions']): Operation[] {
  return taskActions.flatMap((action) => actions[action.id] ? mapping[action.id] : []);
}
export type ReadySetup = { project: Project; table: Table; endpoint: Endpoint };
export type SetupCheck =
  | { kind: 'missing' | 'blocked'; message: string }
  | { kind: 'clean'; project: Project }
  | { kind: 'ready'; setup: ReadySetup };
const conflict = "This project already contains a Tasks configuration that doesn't match this guided setup. Review Tables & fields and APIs before continuing.";

function fieldsMatch(fields: Field[]) {
  return fields.length === taskDraft.fields.length && taskDraft.fields.every((expected) => {
    const field = fields.find((candidate) => candidate.name === expected.name);
    return field && field.type === expected.type && field.nullable === expected.nullable
      && !field.unique && !field.relationship && !field.backfillIntent
      && !Object.keys(field.options ?? {}).length
      && (expected.default?.kind === 'literal'
        ? field.default?.kind === 'literal' && field.default.value === expected.default.value
        : field.default == null);
  });
}
export function tableMatches(table: Table) {
  return table.name === 'tasks' && !!table.appliedRevision
    && table.draftRevision === table.appliedRevision
    && (!table.applyStatus || table.applyStatus.status === 'applied')
    && table.appliedDefinition?.definition.name === 'tasks'
    && !table.indexes?.length && !table.appliedDefinition.definition.indexes?.length
    && fieldsMatch(table.fields) && fieldsMatch(table.appliedDefinition.definition.fields);
}
export function endpointMatches(endpoint: Endpoint, table: Table) {
  const ops = endpoint.enabledOperations;
  return endpoint.tableId === table.id && endpoint.resourceName === 'tasks'
    && endpoint.revision > 0 && ops.length > 0 && new Set(ops).size === ops.length
    && ops.every((op) => Object.values(mapping).flat().includes(op))
    && ops.includes('list') === ops.includes('get')
    && Object.values(endpoint.policies ?? {}).every((policy) => !policy || policy.mode === 'key_only');
}

// Reads platform metadata only; never tests or opens a customer connection.
export async function inspectTaskforge(projectId: string, request: typeof api = api): Promise<SetupCheck> {
  const base = `projects/${projectId}`;
  const [project, connection, tables, endpoints] = await Promise.all([
    request<Project>(base),
    request<Connection>(`${base}/database-connection`).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }),
    request<Table[]>(`${base}/schema`),
    request<Endpoint[]>(`${base}/endpoints`),
  ]);
  if (!connection) return { kind: 'missing', message: 'Connect your database before creating the backend.' };
  if (project.runtimeState === 'suspended') return { kind: 'blocked', message: 'This project is paused. Review the project overview before continuing.' };
  if (tables.some((table) => ['applying', 'failed', 'outcome_unknown'].includes(table.applyStatus?.status ?? ''))) {
    return { kind: 'blocked', message: 'A saved storage change needs attention. Review Tables & fields before continuing.' };
  }
  const tasks = tables.filter((table) => table.name === 'tasks' || table.appliedDefinition?.definition.name === 'tasks');
  if (!tasks.length) return endpoints.some((endpoint) => endpoint.resourceName === 'tasks')
    ? { kind: 'blocked', message: conflict } : { kind: 'clean', project };
  const table = tasks[0];
  const endpoint = endpoints.find((candidate) => candidate.tableId === table.id);
  if (tasks.length !== 1 || !tableMatches(table) || !endpoint || !endpointMatches(endpoint, table)) {
    return { kind: 'blocked', message: conflict };
  }
  return { kind: 'ready', setup: { project, table, endpoint } };
}

export async function createTaskforge(
  projectId: string,
  actions: GuidedState['actions'],
  progress: (message: string) => void,
  request: typeof api = api,
): Promise<ReadySetup> {
  let failure = 'We could not check this project. No setup was started.';
  try {
    const check = await inspectTaskforge(projectId, request);
    if (check.kind === 'ready') return check.setup;
    if (check.kind !== 'clean') throw new Error(check.message);
    const enabledOperations = selectedOperations(actions);
    if (!enabledOperations.length) throw new Error('Choose at least one task action before creating your backend.');
    const base = `projects/${projectId}/schema/tables`;
    progress('Preparing task storage…');
    failure = 'We could not confirm the Tasks draft was saved. Check Tables & fields before trying again.';
    const draft = await request<Table>(base, 'POST', taskDraft);
    failure = 'The Tasks draft was saved, but we could not prepare its storage. Review Tables & fields.';
    const preview = await request<{ draftRevision: number; planHash: string }>(`${base}/${draft.id}/preview`, 'POST');
    if (preview.draftRevision !== draft.draftRevision || !/^[a-f0-9]{64}$/.test(preview.planHash)) throw new Error();
    progress('Creating Tasks table…');
    failure = 'The Tasks draft was saved, but we could not confirm its storage was created. Review Tables & fields before trying again.';
    const applied = await request<{ status: string; table: Table }>(`${base}/${draft.id}/apply`, 'POST', {
      expectedDraftRevision: preview.draftRevision, planHash: preview.planHash,
    });
    if (applied.status !== 'applied' || applied.table.id !== draft.id
      || applied.table.appliedRevision !== preview.draftRevision || !tableMatches(applied.table)) throw new Error();
    progress('Tasks storage created. Enabling task actions…');
    failure = 'The Tasks storage was created, but the API actions could not be confirmed. Review APIs before trying again.';
    const endpoint = await request<Endpoint>(`${base}/${draft.id}/api`, 'PUT', {
      enabledOperations,
      policies: Object.fromEntries(enabledOperations.map((op) => [op, { mode: 'key_only' }])),
      expectedAppliedRevision: applied.table.appliedRevision,
      expectedConfigRevision: 0, // Existing API contract: absent configuration starts at zero.
    });
    if (!endpointMatches(endpoint, applied.table)
      || endpoint.enabledOperations.length !== enabledOperations.length
      || !enabledOperations.every((op) => endpoint.enabledOperations.includes(op))) throw new Error();
    return { project: check.project, table: applied.table, endpoint };
  } catch (error) {
    // Never replay mutations; a lost response may have committed successfully.
    if (error instanceof Error && (error.message === conflict
      || error.message.startsWith('Connect your database')
      || error.message.startsWith('Choose at least')
      || error.message.startsWith('A saved storage')
      || error.message.startsWith('This project is paused'))) throw error;
    throw new Error(failure);
  }
}
