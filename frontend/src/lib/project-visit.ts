'use client';
import { useSyncExternalStore } from 'react';
import type { VisitSuccess } from './project-setup';
let successes: readonly VisitSuccess[] = [];
const empty: readonly VisitSuccess[] = [];
const listeners = new Set<() => void>();
export function recordRuntimeSuccess(
  projectId: string,
  operationId: string,
  status: number,
) {
  if (status < 200 || status >= 300 || !/^(crud_|workflow_)/.test(operationId))
    return;
  successes = [
    ...successes.filter(
      (s) => s.projectId !== projectId || s.operationId !== operationId,
    ),
    { projectId, operationId, success: true },
  ];
  listeners.forEach((fn) => fn());
}
export function clearRuntimeSuccesses() {
  successes = [];
  listeners.forEach((fn) => fn());
}
export function getRuntimeSuccesses() {
  return successes;
}
export function useRuntimeSuccesses() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => successes,
    () => empty,
  );
}
