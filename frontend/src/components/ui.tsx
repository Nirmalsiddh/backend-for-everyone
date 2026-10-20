'use client';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { DirtyGuard } from './navigation-guard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorGuidance } from '@/lib/runtime-guidance';
import { mutationRecovery, supportDetails } from '@/lib/mutation-recovery';
import { CopyButton } from './copy-button';
import { api, ApiError } from '@/lib/api';
export function useData<T>(
  path: string,
  options: { refetchOnMount?: 'always' } = {},
) {
  const query = useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path),
    ...options,
  });
  useEffect(() => {
    const refresh = () => {
      void query.refetch();
    };
    window.addEventListener('dashboard:refresh', refresh);
    return () => window.removeEventListener('dashboard:refresh', refresh);
  }, [path, query.refetch]);
  return query;
}
export function ErrorBox({
  error,
  context = 'dashboard',
}: {
  error: unknown;
  context?: 'dashboard' | 'key' | 'session' | 'public';
}) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : undefined;
  return (
    <div role="alert" className="error">
      <strong>{e?.code ?? 'INVALID_INPUT'}</strong>:{' '}
      {error instanceof Error ? error.message : 'Request failed'}
      {e?.requestId && <small>Request ID: {e.requestId}</small>}
      {e && <p>{errorGuidance(e.status, context)}</p>}
      {e && mutationRecovery(e.code, e.operation, e.status) && (
        <p className="warning">
          {mutationRecovery(e.code, e.operation, e.status)}
        </p>
      )}
      {e?.retryAfter && (
        <p>Try again in approximately {Math.ceil(e.retryAfter)} seconds.</p>
      )}
      {e && (
        <CopyButton text={supportDetails(e)} label="Copy support details" />
      )}
      <p>
        When contacting support, include the project ID, request ID, timestamp,
        operation, and error code. Never send passwords, API keys, database
        URLs, or session tokens.
      </p>
      {context !== 'dashboard' && (
        <p>If something fails, copy the request ID when contacting support.</p>
      )}
      {context === 'dashboard' && e?.status === 409 && (
        <p>
          Your input is preserved. Reload saved data and review before
          submitting again.
        </p>
      )}
      {context === 'dashboard' && e && e.status >= 409 && (
        <button
          type="button"
          className="secondary"
          onClick={() => window.dispatchEvent(new Event('dashboard:refresh'))}
        >
          Refresh saved status (keep edits)
        </button>
      )}
    </div>
  );
}
export function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
export function State({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown };
  children: ReactNode;
}) {
  if (query.isPending) return <p role="status">Loading…</p>;
  if (query.error && !(query as { data?: unknown }).data)
    return <ErrorBox error={query.error} />;
  return (
    <>
      {query.error && (
        <>
          <p className="warning">
            Showing last loaded data. The latest status could not be refreshed.
          </p>
          <ErrorBox error={query.error} />
        </>
      )}
      {children}
    </>
  );
}
export function useAction(
  options: { refresh?: string[]; success?: string; failure?: string } = {},
) {
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  async function run<T>(
    action: () => Promise<T>,
    success?: (v: T) => void,
    feedback?: string,
  ) {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const value = await action();

      if (!mounted.current) return;
      success?.(value);
      setMessage(feedback ?? options.success ?? 'Operation completed');
      return value;
    } catch (e) {
      if (!mounted.current) return;
      setError(e);
      if (options.failure) setMessage(options.failure);
    } finally {
      await Promise.all(
        (options.refresh ?? []).map((path) =>
          client.invalidateQueries({ queryKey: [path], exact: true }),
        ),
      );
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { error, busy, message, run, setMessage };
}
export function ActionState({
  action,
}: {
  action: ReturnType<typeof useAction>;
}) {
  return (
    <>
      <DirtyGuard dirty={action.busy} pending={action.busy} />
      <ErrorBox error={action.error} />
      {action.busy && <p role="status">Working…</p>}
      {action.message && <p role="status">{action.message}</p>}
    </>
  );
}
export { DirtyGuard } from './navigation-guard';

export function MutationBoundary({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="mutation-boundary" disabled={busy} aria-busy={busy}>
      {children}
    </fieldset>
  );
}
