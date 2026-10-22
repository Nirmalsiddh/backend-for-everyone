'use client';
import { useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../lib/api';
import { createTaskforge, inspectTaskforge, type ReadySetup, type SetupCheck } from '../lib/taskforge-setup';
import { guidedReducer, initialGuidedState, taskActions, taskFields } from '../lib/taskforge';
import { SecretDialog } from './secret-dialog';
import { CopyButton } from './copy-button';
import { RuntimeUrl } from './runtime-url';

export function GuidedBuilder({ projectId }: { projectId: string }) {
  const [state, dispatch] = useReducer(guidedReducer, initialGuidedState);
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [ready, setReady] = useState<ReadySetup | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [secret, setSecret] = useState('');
  const [keyAttempted, setKeyAttempted] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [origin, setOrigin] = useState('');
  const pending = useRef(false);
  const keyPending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(state.view);
  useEffect(() => {
    if (previousView.current !== state.view) heading.current?.focus();
    previousView.current = state.view;
  }, [state.view]);
  useEffect(() => {
    let cancelled = false;
    setOrigin(document.querySelector('meta[name="runtime-origin"]')?.getAttribute('content') ?? '');
    void inspectTaskforge(projectId).then((result) => {
      if (cancelled) return;
      setCheck(result);
      if (result.kind === 'ready') {
        setReady(result.setup);
        dispatch({ type: 'ready' });
      }
    }).catch(() => {
      if (!cancelled) setError('We could not check this project. Reload this page to check again. No setup was started.');
    });
    return () => { cancelled = true; };
  }, [projectId]);
  const selected = taskActions.filter((action) => state.actions[action.id]);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const canCreate = check?.kind === 'clean' && !error && selected.length > 0;
  const continueHelp = error ? 'Setup is paused. Review the message above before continuing.'
    : !check ? 'Checking your saved settings before you continue.'
    : check.kind === 'missing' ? 'Connect your database first, then return here.'
    : check.kind === 'blocked' ? 'Review your existing setup using the links above.'
    : !selected.length ? 'Choose at least one task action to continue.'
    : 'Next: review your choices before creating anything.';
  const title = state.view === 'build' ? 'Build your Task Manager'
    : state.view === 'review' ? 'Review your backend'
    : state.view === 'creating' ? 'Creating your backend' : 'Backend Ready ✓';

  async function create() {
    if (pending.current || !canCreate) return;
    pending.current = true;
    dispatch({ type: 'creating' });
    setError('');
    setProgress('Checking your project…');
    try {
      const result = await createTaskforge(projectId, state.actions, setProgress);
      setReady(result);
      dispatch({ type: 'ready' });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Setup stopped. Review your saved configuration before trying again.');
      dispatch({ type: 'continue' });
    } finally {
      pending.current = false;
    }
  }

  async function createKey() {
    if (keyPending.current || keyAttempted || !ready) return;
    keyPending.current = true;
    setKeyAttempted(true);
    setKeyBusy(true);
    try {
      const result = await api<{ key: string }>(`projects/${projectId}/api-keys`, 'POST', {
        name: 'Taskforge demo', scope: 'read_write',
      });
      if (!result.key) throw new Error();
      setSecret(result.key);
    } catch {
      setKeyError('The key creation response could not be confirmed. Check API keys before creating another key.');
    } finally {
      setKeyBusy(false);
    }
  }

  const operations = ready?.endpoint.enabledOperations ?? [];
  const enabledLabels = taskActions.filter((action) => {
    const operation = { create: 'create', view: 'list', edit: 'update', delete: 'delete' } as const;
    return operations.includes(operation[action.id]);
  });
  const apiUrl = ready && origin ? `${origin}/api/${ready.project.slug}` : '';
  const example = apiUrl ? [
    `const API_URL = ${JSON.stringify(apiUrl)};`,
    'const API_KEY = "<your-read-write-api-key>";',
    ...(operations.includes('create') ? [
      '', 'const created = await fetch(`${API_URL}/tasks`, {',
      '  method: "POST",', '  headers: {', '    Authorization: `Bearer ${API_KEY}`,', '    "Content-Type": "application/json"', '  },',
      '  body: JSON.stringify({ title: "Finish assignment", completed: false })',
      '});', 'if (!created.ok) throw new Error(`Create failed: ${created.status}`);',
    ] : []),
    ...(operations.includes('list') ? [
      '', 'const listed = await fetch(`${API_URL}/tasks`, {',
      '  headers: { Authorization: `Bearer ${API_KEY}` }', '});',
      'if (!listed.ok) throw new Error(`List failed: ${listed.status}`);',
      'const { data: tasks } = await listed.json();',
    ] : []),
  ].join('\n') : '';

  return (
    <div className="guided-builder">
      <p className="guided-eyebrow">Backend for Everyone</p>
      <nav className="guided-progress" aria-label="Builder progress">
        <ol>
          {(['build', 'review', 'creating', 'ready'] as const).map((view, index, steps) => {
            const completed = index < steps.indexOf(state.view);
            return (
              <li key={view} data-completed={completed} aria-current={state.view === view ? 'step' : undefined}>
                <span className="guided-step-number" aria-hidden="true">{completed ? '✓' : index + 1}</span>
                <span><span className="guided-sr-only">{index + 1}. </span>{view === 'build' ? 'Build' : view === 'review' ? 'Review' : view === 'creating' ? 'Create' : 'Ready'}{completed && <span className="guided-sr-only"> — completed</span>}</span>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className={`guided-heading${state.view === 'ready' ? ' guided-success' : ''}`}>
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        {state.view === 'build' && <p>Built your frontend? Choose what your Task Manager needs. We’ll handle the backend setup.</p>}
        {state.view === 'review' && <p>Check everything before we create it.</p>}
        {state.view === 'creating' && <p>Keep this page open while we finish the setup.</p>}
        {state.view === 'ready' && <p role="status">Your Task Manager backend is configured and ready to use.</p>}
      </div>
      {(error || check?.kind === 'missing' || check?.kind === 'blocked') && (
        <div className="guided-notice" role="alert">
          <strong>Setup needs attention</strong>
          {error && <><p>{error}</p><p>Setup has stopped. No automatic retry will run.</p></>}
          {check && (check.kind === 'missing' || check.kind === 'blocked') && <p>{check.message}</p>}
          {(error || check?.kind === 'blocked') && <div className="guided-actions"><a href={`${base}/schema`}>Review Tables &amp; fields</a><a href={`${base}/apis`}>Review APIs</a></div>}
          {check?.kind === 'missing' && <a href={`${base}/database`}>Connect database</a>}
        </div>
      )}
      {state.view === 'build' ? (
        <>
          <section className="guided-template" aria-labelledby="template-heading">
            <h2 id="template-heading">Task Manager template</h2>
            <p>A simple place to keep track of tasks and deadlines.</p>
          </section>
          <section className="guided-information" aria-labelledby="fields-heading">
            <h2 id="fields-heading">Task information</h2>
            <dl className="guided-field-grid">{taskFields.map((field) => (
              <div key={field.label}>
                <dt><span>{field.label}</span><span className="guided-meta">{field.label === 'Title' ? 'Required' : field.label === 'Completed' ? 'Starts unfinished' : 'Optional'}</span></dt>
                <dd>{field.description}</dd>
              </div>
            ))}</dl>
          </section>
          <form onSubmit={(event) => { event.preventDefault(); dispatch({ type: 'continue' }); }}>
            <fieldset><legend>What should your app be able to do?</legend>
              <div className="guided-choice-grid">{taskActions.map((action) => (
                <label className="guided-choice" key={action.id} htmlFor={`task-${action.id}`}>
                  <input id={`task-${action.id}`} type="checkbox" checked={state.actions[action.id]}
                    aria-labelledby={`task-${action.id}-label`} aria-describedby={`task-${action.id}-description`}
                    onChange={(event) => dispatch({ type: 'toggle', action: action.id, checked: event.target.checked })} />
                  <span><span className="guided-choice-title" id={`task-${action.id}-label`}>{action.label}</span>
                    <small id={`task-${action.id}-description`}>{({ create: 'Add new tasks', view: 'See saved tasks', edit: 'Change existing tasks', delete: 'Remove tasks' })[action.id]}</small>
                  </span>
                </label>
              ))}</div>
            </fieldset>
            <section className="guided-prerequisite" aria-labelledby="database-heading">
              <div><h2 id="database-heading">Database</h2>
                {!check && !error && <p role="status">Checking saved project settings…</p>}
                {check?.kind === 'clean' && <p>✓ Saved connection found</p>}
                {check?.kind === 'missing' && <p>Connection required</p>}
                {check?.kind === 'blocked' && <p>Configuration needs attention</p>}
                {error && <p>Could not confirm saved settings</p>}
              </div>
              <a href={`${base}/database`}>Open Database Settings</a>
            </section>
            <div className="guided-footer">
              <p id="continue-help" className="guided-supporting">{continueHelp}</p>
              <button type="submit" disabled={!canCreate} aria-describedby="continue-help">Continue <span aria-hidden="true">→</span></button>
            </div>
          </form>
        </>
      ) : state.view === 'creating' ? (
        <section className="guided-panel guided-process" aria-label="Setup progress">
          <span className="guided-process-mark" aria-hidden="true">···</span>
          <p role="status" aria-live="polite">{progress}</p>
          <p className="guided-supporting">We’re preparing task storage and your selected actions.</p>
        </section>
      ) : state.view === 'review' ? (
        <>
          <section className="guided-panel guided-review" aria-label="Backend summary">
            <div className="guided-review-columns">
              <div><h2>Data</h2><ul>{taskFields.map((field) => <li key={field.label}>{field.summary}</li>)}</ul></div>
              <div><h2>Actions</h2><ul>{selected.map((action) => <li key={action.id}>✓ {action.label}</li>)}</ul></div>
            </div>
            <div className="guided-review-database"><h2>Database</h2><p>{check?.kind === 'clean' ? '✓ Saved connection found' : continueHelp}</p><a href={`${base}/database`}>Database settings</a></div>
          </section>
          <p className="guided-supporting">This creates Tasks storage and your selected actions. An API key is created separately.</p>
          <div className="guided-footer">
            <p id="create-help" className="guided-supporting">{canCreate ? 'Ready to create. Your choices will now be applied to your database.' : continueHelp}</p>
            <div className="guided-actions guided-review-actions">
              <button type="button" className="secondary" onClick={() => dispatch({ type: 'back' })}>Back</button>
              <button type="button" disabled={!canCreate} aria-describedby="create-help" onClick={() => void create()}>Create Backend</button>
            </div>
          </div>
        </>
      ) : ready ? (
        <>
          <div className="guided-ready-summary">
            <div><h2>Tasks storage</h2><p>✓ Ready</p></div>
            <div><h2>Available actions</h2><ul>{enabledLabels.map((action) => <li key={action.id}>{action.label}</li>)}</ul></div>
          </div>
          <section className="guided-api" aria-labelledby="api-heading">
            <h2 id="api-heading">API address</h2>
            <div className="guided-url"><RuntimeUrl slug={ready.project.slug} /></div>
            <details className="guided-endpoints"><summary>Endpoint details</summary>
              <ul>{operations.map((operation) => (
                <li key={operation}><code>{({ create: 'POST', list: 'GET', get: 'GET', update: 'PATCH', delete: 'DELETE' } as const)[operation]} /tasks{['get', 'update', 'delete'].includes(operation) ? '/:id' : ''}</code></li>
              ))}</ul>
            </details>
          </section>
          <section className="guided-panel guided-next" aria-labelledby="next-heading">
            <h2 id="next-heading">Next steps</h2>
            <ol>
              <li><span className="guided-next-number" aria-hidden="true">1</span><div>
                <h3>Get a demo key</h3>
                <p>This key is shown once. Copy it now. Keep write-enabled keys private; do not publish them in a public frontend.</p>
                <button type="button" disabled={keyAttempted || keyBusy} onClick={() => void createKey()}>Create demo API key</button>
                {keyBusy && <p role="status">Creating demo key…</p>}
                {keyAttempted && !keyBusy && !keyError && !secret && <p role="status">Key created and cleared from this page. If you need another key, use API keys.</p>}
                {keyError && <p className="guided-notice" role="alert">{keyError}</p>}
                <p><a href={`${base}/keys`}>Manage API keys</a></p>
              </div></li>
              <li><span className="guided-next-number" aria-hidden="true">2</span><div>
                <h3>Test your API</h3>
                <p>In Playground, choose API key and paste your key into Runtime credential. Create a task, then view the list to test it.</p>
                <div className="guided-actions">
                  {operations.includes('create') && <a className="guided-link-button" href={`${base}/playground?target=table:${ready.endpoint.id}:create`}>Test Create Task</a>}
                  {operations.includes('list') && <a className="guided-link-button secondary" href={`${base}/playground?target=table:${ready.endpoint.id}:list`}>Test View Tasks</a>}
                </div>
                <p><a href={`${base}/playground`}>Open Playground</a></p>
              </div></li>
              {(operations.includes('create') || operations.includes('list')) && <li><span className="guided-next-number" aria-hidden="true">3</span><div>
                <h3>Connect your app</h3>
                <details className="guided-code"><summary>JavaScript example</summary>
                  <p>Use this example in a controlled demo or trusted server. Replace the key placeholder privately; never publish a write key in a public frontend.</p>
                  {example ? <><div className="guided-code-toolbar"><span>JavaScript</span><CopyButton text={example} label="Copy fetch example" /></div><pre tabIndex={0} aria-label="JavaScript integration example"><code>{example}</code></pre></> : <p>The public API address is unavailable. Check the dashboard runtime origin settings.</p>}
                </details>
              </div></li>}
            </ol>
          </section>
          {secret && <SecretDialog secret={secret} onClose={() => setSecret('')} />}
          <p className="guided-back-link"><a href={base}>Back to project overview</a></p>
        </>
      ) : null}
    </div>
  );
}
