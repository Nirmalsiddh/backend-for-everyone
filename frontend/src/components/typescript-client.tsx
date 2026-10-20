'use client';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './copy-button';
interface GeneratedClient {
  filename: string;
  generatorVersion: string;
  contractHash: string;
  tableRevisions: Record<string, number>;
  source: string;
}
export function TypeScriptClient({ projectId }: { projectId: string }) {
  const sequence = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const [result, setResult] = useState<{ projectId: string; data: GeneratedClient }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    sequence.current++;
    controller.current?.abort();
    setResult(undefined);
    setError('');
    setPending(false);
    return () => { sequence.current++; controller.current?.abort(); };
  }, [projectId]);
  const current = result?.projectId === projectId ? result.data : undefined;
  async function generate() {
    const request = ++sequence.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setPending(true);
    setResult(undefined);
    setError('');
    try {
      const response = await fetch(`/api/management/projects/${projectId}/sdk/typescript`, { cache: 'no-store', signal: controller.current.signal });
      if (!response.ok) throw new Error('Generation unavailable. Review applied schema, endpoint policies and application authentication.');
      const data = await response.json() as GeneratedClient;
      if (sequence.current === request) setResult({ projectId, data });
    } catch (cause) {
      if (sequence.current === request) setError(cause instanceof Error ? cause.message : 'Generation failed');
    } finally { if (sequence.current === request) setPending(false); }
  }
  function download() {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current.source], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = current.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <section aria-label="TypeScript client">
    <h2>TypeScript client</h2>
    <p>One standalone file for modern fetch environments. Regenerate after applied API changes, endpoint changes or authentication changes. Normal non-unique indexes do not change it. Workflow helpers are not generated. Enabled PATCH operations with no writable fields are omitted.</p>
    <p>Use application sessions for user-specific browser access. Project keys are shared credentials without per-user ownership identity. Keep write keys in trusted servers or BFFs; read-only keys are also shared. The client stores no tokens and never uses dashboard cookies.</p>
    <p>Configure baseUrl as the runtime project root, including /api/project-slug. Bigint and decimal values remain exact strings. Requires ES2022 and standard web fetch/URL typings.</p>
    <button type="button" disabled={pending} onClick={() => void generate()}>{pending ? 'Generating…' : current ? 'Refresh TypeScript client' : 'Generate TypeScript client'}</button>
    {pending && <p role="status">Generating TypeScript client…</p>}
    {error && <p role="alert">{error}</p>}
    {current && <>
      <p>Filename: {current.filename}</p>
      <p>Contract hash: <code>{current.contractHash}</code></p>
      <p>Generator version: {current.generatorVersion}. Logical table revisions are diagnostic provenance; the contract hash also covers endpoint/auth configuration.</p>
      <ul>{Object.entries(current.tableRevisions).map(([table, revision]) => <li key={table}>{table}: {revision}</li>)}</ul>
      <CopyButton key={current.contractHash} text={current.source} label="Copy TypeScript client" />
      <button type="button" onClick={download}>Download .ts</button>
      <details><summary>Source preview</summary><pre aria-label="TypeScript source"><code>{current.source}</code></pre></details>
    </>}
  </section>;
}
