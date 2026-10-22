export const taskFields = [
  { label: 'Title', description: 'The name of the task.', summary: 'Task titles' },
  { label: 'Description', description: 'Extra details about the task.', summary: 'Descriptions' },
  { label: 'Completed', description: 'Whether the task is finished.', summary: 'Completion status' },
  { label: 'Due date', description: 'When the task should be completed.', summary: 'Due dates' },
] as const;

export const taskActions = [
  { id: 'create', label: 'Create tasks' },
  { id: 'view', label: 'View tasks' },
  { id: 'edit', label: 'Edit tasks' },
  { id: 'delete', label: 'Delete tasks' },
] as const;
export type TaskAction = (typeof taskActions)[number]['id'];
export type GuidedState = {
  template: 'task-manager';
  view: 'build' | 'review' | 'preview';
  actions: Record<TaskAction, boolean>;
};
export const initialGuidedState: GuidedState = {
  template: 'task-manager',
  view: 'build',
  actions: { create: true, view: true, edit: true, delete: true },
};
export type GuidedEvent =
  | { type: 'toggle'; action: TaskAction; checked: boolean }
  | { type: 'continue' | 'back' | 'preview' | 'review' };

// H1 only: transitions update local choices; they never configure a backend.
export function guidedReducer(state: GuidedState, event: GuidedEvent): GuidedState {
  switch (event.type) {
    case 'toggle':
      return { ...state, actions: { ...state.actions, [event.action]: event.checked } };
    case 'continue': return { ...state, view: 'review' };
    case 'back': return { ...state, view: 'build' };
    case 'preview': return { ...state, view: 'preview' };
    case 'review': return { ...state, view: 'review' };
  }
}
