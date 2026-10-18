import type { Definition, Step, Table, Value } from './contracts';
export type ReferenceOption = { label: string; value: Value };
export function references(
  def: Definition,
  previous: Step[],
  tables: Table[],
): ReferenceOption[] {
  const refs: ReferenceOption[] = Object.keys(def.input).map((name) => ({
    label: `Request: ${name}`,
    value: { kind: 'reference', source: 'request', path: ['body', name] },
  }));
  if (def.auth === 'authenticated')
    for (const key of ['id', 'role'])
      refs.push({
        label: `Auth user: ${key}`,
        value: { kind: 'reference', source: 'auth', path: ['user', key] },
      });
  for (const step of previous) {
    if (step.type === 'response') break;
    if (step.type === 'condition') {
      if (terminates(step.then) && terminates(step.else)) break;
      continue;
    }
    if (step.type !== 'delete')
      refs.push({
        label: `${step.name}: row`,
        value: {
          kind: 'reference',
          source: 'step',
          stepId: step.id,
          path: ['row'],
        },
      });
    const fields = step.type === 'delete' ? ['id'] : step.select;
    for (const field of fields) {
      const table = tables.find((t) => t.id === step.tableId);
      const label =
        field === 'id'
          ? 'id'
          : (table?.appliedDefinition?.definition.fields.find(
              (f) => f.id === field,
            )?.name ?? field);
      refs.push({
        label: `${step.name}: ${label}`,
        value: {
          kind: 'reference',
          source: 'step',
          stepId: step.id,
          path: step.type === 'delete' ? ['id'] : ['row', field],
        },
      });
    }
  }
  return refs;
}
export function newStep(
  type: Step['type'],
  name: string,
  auth: Definition['auth'],
): Step {
  const base = { id: crypto.randomUUID(), name };
  const literal: Value = { kind: 'literal', value: '' };
  if (type === 'response')
    return { ...base, type, status: 200, body: { kind: 'object', fields: {} } };
  if (type === 'condition')
    return {
      ...base,
      type,
      operator: 'equals',
      left: literal,
      right: literal,
      then: [newStep('response', name + '_yes', auth)],
      else: [newStep('response', name + '_no', auth)],
    };
  const db = { ...base, tableId: '', access: { mode: auth } as const };
  if (type === 'insert') return { ...db, type, select: ['id'], values: {} };
  if (type === 'query')
    return { ...db, type, select: ['id'], idValue: literal, onMissing: '404' };
  if (type === 'update')
    return {
      ...db,
      type,
      select: ['id'],
      idValue: literal,
      assignments: [],
      onNoMatch: 409,
    };
  return { ...db, type, idValue: literal };
}
export function counts(
  steps: Step[],
  depth = 0,
): { steps: number; db: number; tables: Set<string>; depth: number } {
  const result = { steps: 0, db: 0, tables: new Set<string>(), depth };
  for (const step of steps) {
    result.steps++;
    if (step.type === 'condition') {
      for (const branch of [step.then, step.else]) {
        const c = counts(branch, depth + 1);
        result.steps += c.steps;
        result.db += c.db;
        c.tables.forEach((t) => result.tables.add(t));
        result.depth = Math.max(result.depth, c.depth);
      }
    } else if (step.type !== 'response') {
      result.db++;
      if (step.tableId) result.tables.add(step.tableId);
    }
  }
  return result;
}

export function terminates(steps: Step[]): boolean {
  return steps.some(
    (step) =>
      step.type === 'response' ||
      (step.type === 'condition' &&
        terminates(step.then) &&
        terminates(step.else)),
  );
}

export function reconcileAuth(steps: Step[], auth: Definition['auth']): Step[] {
  return steps.map((step) =>
    step.type === 'condition'
      ? {
          ...step,
          then: reconcileAuth(step.then, auth),
          else: reconcileAuth(step.else, auth),
        }
      : 'access' in step
        ? {
            ...step,
            access:
              auth === 'key_only'
                ? { mode: 'key_only' }
                : step.access.mode === 'owner'
                  ? step.access
                  : { mode: 'authenticated' },
          }
        : step,
  );
}
export function insertStep(steps: Step[], step: Step, index?: number) {
  const position =
    index ??
    (steps.at(-1)?.type === 'response' ? steps.length - 1 : steps.length);
  return [...steps.slice(0, position), step, ...steps.slice(position)];
}
