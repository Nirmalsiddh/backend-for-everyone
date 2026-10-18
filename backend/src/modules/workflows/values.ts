import { RuntimeError } from '../../runtime/errors.js';
import { invalid } from '../schema-builder/errors.js';
import type { Value } from './types.js';
export const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function keys(value: object, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid('Unknown workflow property');
}
export function boundedJson(value: unknown, bytes: number) {
  const walk = (item: unknown, depth: number): boolean => {
    if (depth > 20) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item))
      return item.every((child) => walk(child, depth + 1));
    return (
      object(item) &&
      Object.entries(item).every(
        ([key, child]) => !forbidden.has(key) && walk(child, depth + 1),
      )
    );
  };
  if (!walk(value, 0) || Buffer.byteLength(JSON.stringify(value)) > bytes)
    throw invalid('Workflow JSON exceeds supported limits');
}
export interface Context {
  request: {
    body: Record<string, unknown>;
    query: Record<string, unknown>;
    params: Record<string, unknown>;
  };
  auth: { user?: { id: string; role: string } };
  steps: Record<string, unknown>;
  variables: Record<string, unknown>;
}
export function executionError(): RuntimeError {
  return new RuntimeError(
    500,
    'WORKFLOW_EXECUTION_FAILED',
    'Workflow could not be completed',
  );
}
export function resolveValue(value: Value, context: Context): unknown {
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'object')
    return Object.fromEntries(
      Object.entries(value.fields).map(([key, child]) => [
        key,
        resolveValue(child, context),
      ]),
    );
  if (value.kind === 'array')
    return value.items.map((child) => resolveValue(child, context));
  let current: unknown =
    value.source === 'step'
      ? context.steps[value.stepId]
      : context[value.source];
  for (const key of value.path) {
    if (forbidden.has(key) || !object(current) || !Object.hasOwn(current, key))
      throw executionError();
    current = current[key];
  }
  if (current === undefined) throw executionError();
  return current;
}
