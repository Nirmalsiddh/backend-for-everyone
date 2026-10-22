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
      <p className="badge">Backend for Everyone</p>
      <nav aria-label="Builder progress">
        <ol>
          {(['build', 'review', 'creating', 'ready'] as const).map((view, index) => (
            <li key={view} aria-current={state.view === view ? 'step' : undefined}>
              {index + 1}. {view === 'build' ? 'Build' : view === 'review' ? 'Review' : view === 'creating' ? 'Creating' : 'Ready'}
            </li>
          ))}
        </ol>
      </nav>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {error && <div role="alert"><p>{error}</p><p>Setup has stopped. No automatic retry will run.</p></div>}
      {check && (check.kind === 'missing' || check.kind === 'blocked') && <p role="alert">{check.message}</p>}
      {(error || check?.kind === 'blocked') && <p><a href={`${base}/schema`}>Review Tables &amp; fields</a> · <a href={`${base}/apis`}>Review APIs</a></p>}
      {state.view === 'build' ? (
        <>
          <p>Built your frontend? Give it a backend without writing a server, routes or database queries. Start with a few simple choices.</p>
          <section aria-labelledby="template-heading">
            <h2 id="template-heading">What are you building?</h2>
            <p><strong>Task Manager</strong> — the template for this guided setup.</p>
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
                  <input id={`task-${action.id}`} type="checkbox" checked={state.actions[action.id]}
                    onChange={(event) => dispatch({ type: 'toggle', action: action.id, checked: event.target.checked })} />
                  {action.label}
                </label>
              ))}
            </fieldset>
            <section aria-labelledby="database-heading">
              <h2 id="database-heading">Database setup</h2>
              {!check && !error && <p role="status">Checking saved project settings…</p>}
              {check?.kind === 'clean' && <p>✓ Saved database connection found. Your database must allow task storage and actions to be created.</p>}
              <a href={`${base}/database`}>Open Database Settings</a>
            </section>
            <p id="continue-help" className="muted">{continueHelp}</p>
            <button type="submit" disabled={!canCreate} aria-describedby="continue-help">Continue</button>
          </form>
        </>
      ) : state.view === 'creating' ? (
        <section aria-label="Setup progress"><p role="status" aria-live="polite">{progress}</p><p>Please keep this page open. We’re creating task storage and turning on your selected actions.</p></section>
      ) : state.view === 'review' ? (
        <>
          <section aria-labelledby="data-heading">
            <h2 id="data-heading">Your Task Manager will store</h2>
            <ul>{taskFields.map((field) => <li key={field.label}>{field.summary}</li>)}</ul>
          </section>
          <section aria-labelledby="actions-heading">
            <h2 id="actions-heading">Users will be able to</h2>
            <ul>{selected.map((action) => <li key={action.id}>{action.label}</li>)}</ul>
          </section>
          <p>This will create Tasks storage and enable the selected actions in your connected database. It will not create an API key automatically.</p>
          <button type="button" className="secondary" onClick={() => dispatch({ type: 'back' })}>Back</button>
          <p id="create-help" className="muted">{canCreate ? 'Ready to create. Your choices will now be applied to your database.' : continueHelp}</p>
          <button type="button" disabled={!canCreate} aria-describedby="create-help" onClick={() => void create()}>Create Backend</button>
          <p><a href={`${base}/database`}>Database settings</a></p>
        </>
      ) : ready ? (
        <>
          <p role="status">Your Task Manager backend is ready to use. Backend configured ✓</p>
          <div className="guided-summary">
            <section><h2>Data</h2><p>✓ Tasks storage ready</p></section>
            <section><h2>Available actions</h2><ul>{enabledLabels.map((action) => <li key={action.id}>✓ {action.label}</li>)}</ul></section>
          </div>
          <section aria-labelledby="api-heading">
            <h2 id="api-heading">API address</h2>
            <RuntimeUrl slug={ready.project.slug} />
            <details><summary>View endpoint list</summary>
              <ul>{operations.map((operation) => (
                <li key={operation}><code>{({ create: 'POST', list: 'GET', get: 'GET', update: 'PATCH', delete: 'DELETE' } as const)[operation]} /tasks{['get', 'update', 'delete'].includes(operation) ? '/:id' : ''}</code></li>
              ))}</ul>
            </details>
          </section>
          <section aria-labelledby="key-heading">
            <h2 id="key-heading">1. Get a demo key</h2>
            <p>This key is shown once. Copy it now. Keep write-enabled keys private; do not publish them in a public frontend.</p>
            <button type="button" disabled={keyAttempted || keyBusy} onClick={() => void createKey()}>Create demo API key</button>
            {keyBusy && <p role="status">Creating demo key…</p>}
            {keyAttempted && !keyBusy && !keyError && !secret && <p role="status">Key created and cleared from this page. If you need another key, use API keys.</p>}
            {keyError && <p role="alert">{keyError}</p>}
            <p><a href={`${base}/keys`}>Manage API keys</a></p>
          </section>
          <section aria-labelledby="test-heading">
            <h2 id="test-heading">2. Test a task</h2>
            <p>Your backend is configured. In Playground, choose API key and paste your key into Runtime credential. Create a task, then view the list to test it.</p>
            <div className="guided-actions">
              {operations.includes('create') && <a className="guided-link-button" href={`${base}/playground?target=table:${ready.endpoint.id}:create`}>Test Create Task</a>}
              {operations.includes('list') && <a className="guided-link-button secondary" href={`${base}/playground?target=table:${ready.endpoint.id}:list`}>Test View Tasks</a>}
            </div>
            <p><a href={`${base}/playground`}>Open Playground</a></p>
          </section>
          {secret && <SecretDialog secret={secret} onClose={() => setSecret('')} />}
          {(operations.includes('create') || operations.includes('list')) && <section><h2>3. Connect your app</h2>
            <p>Copy this fetch example for a controlled demo or trusted server. Replace the key placeholder privately; never publish a write key in a public frontend.</p>
            {example ? <><pre tabIndex={0} aria-label="JavaScript integration example"><code>{example}</code></pre><CopyButton text={example} label="Copy fetch example" /></> : <p>The public API address is unavailable. Check the dashboard runtime origin settings.</p>}
          </section>}
          <p><a href={base}>Back to project overview</a></p>
        </>
      ) : null}
    </div>
  );
}
