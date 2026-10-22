'use client';
import { useEffect, useReducer, useRef } from 'react';
import {
  guidedReducer, initialGuidedState, taskActions, taskFields,
} from '../lib/taskforge';

export function GuidedBuilder({ projectId }: { projectId: string }) {
  const [state, dispatch] = useReducer(guidedReducer, initialGuidedState);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(state.view);
  useEffect(() => {
    if (previousView.current !== state.view) heading.current?.focus();
    previousView.current = state.view;
  }, [state.view]);
  const selected = taskActions.filter((action) => state.actions[action.id]);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const title = state.view === 'build' ? 'Build your Task Manager'
    : state.view === 'review' ? 'Review your backend' : 'Setup preview ready';
  return (
    <div className="guided-builder">
      <p className="badge">Backend for Everyone · UI preview</p>
      <nav aria-label="Builder progress">
        <ol>
          {(['build', 'review', 'preview'] as const).map((view, index) => (
            <li key={view} aria-current={state.view === view ? 'step' : undefined}>
              {index + 1}. {view === 'build' ? 'Build' : view === 'review' ? 'Review' : 'Preview'}
            </li>
          ))}
        </ol>
      </nav>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {state.view === 'build' ? (
        <>
          <p>Tell us what your app needs. Review a simple plan for your backend before anything is created.</p>
          <section aria-labelledby="template-heading">
            <h2 id="template-heading">What are you building?</h2>
            <p><strong>Task Manager</strong> — the template for this guided preview.</p>
          </section>
          <section aria-labelledby="fields-heading">
            <h2 id="fields-heading">What information should your app store?</h2>
            <dl>{taskFields.map((field) => (
              <div key={field.label}><dt>{field.label}</dt><dd>{field.description}</dd></div>
            ))}</dl>
          </section>
          <form onSubmit={(event) => { event.preventDefault(); dispatch({ type: 'continue' }); }}>
            <fieldset>
              <legend>What should your app be able to do?</legend>
              {taskActions.map((action) => (
                <label className="check" key={action.id} htmlFor={`task-${action.id}`}>
                  <input id={`task-${action.id}`} type="checkbox"
                    checked={state.actions[action.id]}
                    onChange={(event) => dispatch({ type: 'toggle', action: action.id, checked: event.target.checked })} />
                  {action.label}
                </label>
              ))}
            </fieldset>
            <section aria-labelledby="database-heading">
              <h2 id="database-heading">Database setup</h2>
              <p>Database setup is required before creating the real backend. This preview does not check or change your connection.</p>
              <a href={`${base}/database`}>Open Database Settings</a>
            </section>
            <button type="submit">Continue</button>
          </form>
        </>
      ) : (
        <>
          {state.view === 'preview' && (
            <p role="status">Your choices are ready to review. No backend has been created or changed.</p>
          )}
          <section aria-labelledby="data-heading">
            <h2 id="data-heading">{state.view === 'review' ? 'Your Task Manager will store' : 'Planned data'}</h2>
            {state.view === 'preview' && <p>Tasks storage — planned</p>}
            <ul>{taskFields.map((field) => <li key={field.label}>{field.summary}</li>)}</ul>
          </section>
          <section aria-labelledby="actions-heading">
            <h2 id="actions-heading">{state.view === 'review' ? 'Users will be able to' : 'Planned API actions'}</h2>
            {selected.length ? <ul>{selected.map((action) => <li key={action.id}>{action.label}</li>)}</ul>
              : <p>No actions selected. Go back to choose what your app can do.</p>}
          </section>
          {state.view === 'review' ? (
            <>
              <p id="preview-help">H1 is a preview only. Create Backend shows your plan; it does not create storage or APIs.</p>
              <button type="button" className="secondary" onClick={() => dispatch({ type: 'back' })}>Back</button>
              <button type="button" aria-describedby="preview-help" onClick={() => dispatch({ type: 'preview' })}>Create Backend</button>
            </>
          ) : (
            <>
              <p>In H2, these choices will be applied using the platform’s existing backend engine.</p>
              <button type="button" onClick={() => dispatch({ type: 'review' })}>Review choices</button>
              <p><a href={`${base}/database`}>Database settings</a></p>
              <p><a href={base}>Back to project overview</a></p>
            </>
          )}
        </>
      )}
    </div>
  );
}
