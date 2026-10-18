import type { Step, Field } from './contracts';
export class RequestSequence {
  private sequence = 0;
  private controller?: AbortController;
  invalidate() {
    this.sequence++;
    this.controller?.abort();
    this.controller = undefined;
  }
  start() {
    this.invalidate();
    this.controller = new AbortController();
    return { id: this.sequence, signal: this.controller.signal };
  }
  current(id: number) {
    return id === this.sequence;
  }
}
export function exampleBody(fields: Field[], ownerFieldId?: string) {
  return Object.fromEntries(
    fields
      .filter((f) => !f.nullable && !f.default && f.id !== ownerFieldId)
      .map((f) => [f.name, exampleValue(f)]),
  );
}
export function exampleValue(f: Field): unknown {
  switch (f.type) {
    case 'integer':
      return 1;
    case 'bigint':
    case 'decimal':
      return '1';
    case 'boolean':
      return true;
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'date':
      return '2026-10-18';
    case 'timestamp':
      return '2026-10-18T12:00:00Z';
    case 'jsonb':
      return {};
    default:
      return 'example';
  }
}
export function parseResponse(text: string): { body: unknown; empty: boolean } {
  if (text === '') return { body: null, empty: true };
  try {
    return { body: JSON.parse(text), empty: false };
  } catch {
    return { body: text, empty: false };
  }
}

export function workflowWrites(steps: Step[]): boolean {
  return steps.some(
    (step) =>
      ['insert', 'update', 'delete'].includes(step.type) ||
      (step.type === 'condition' &&
        (workflowWrites(step.then) || workflowWrites(step.else))),
  );
}
