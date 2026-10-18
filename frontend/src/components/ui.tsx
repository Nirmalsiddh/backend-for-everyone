'use client';
import { useState, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
export function useData<T>(path: string) {
  const query = useQuery({ queryKey: [path], queryFn: () => api<T>(path) });
  useEffect(() => {
    const refresh = () => {
      void query.refetch();
    };
    window.addEventListener('dashboard:refresh', refresh);
    return () => window.removeEventListener('dashboard:refresh', refresh);
  }, [path, query.refetch]);
  return query;
}
const errorHints: Record<number, string> = {
  400: 'Check the request fields.',
  401: 'Your session has expired. Sign in again.',
  403: 'Permission or credential scope denied.',
  404: 'Resource unavailable.',
  429: 'Rate limit reached. Wait before trying again.',
  503: 'Service unavailable or database state requires review.',
  504: 'Request timed out. A write may have completed; review saved state before retrying.',
};
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : undefined;
  return (
    <div role="alert" className="error">
      <strong>{e?.code ?? 'INVALID_INPUT'}</strong>:{' '}
      {error instanceof Error ? error.message : 'Request failed'}
      {e?.requestId && <small>Request ID: {e.requestId}</small>}
      {e && errorHints[e.status] && <p>{errorHints[e.status]}</p>}
      {e?.status === 409 && (
        <p>
          Your input is preserved. Reload saved data and review before
          submitting again.
        </p>
      )}
      {e && e.status >= 409 && (
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
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  async function run<T>(
    action: () => Promise<T>,
    success?: (v: T) => void,
    feedback?: string,
  ) {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const value = await action();

      success?.(value);
      setMessage(feedback ?? options.success ?? 'Operation completed');
      return value;
    } catch (e) {
      setError(e);
      if (options.failure) setMessage(options.failure);
    } finally {
      await Promise.all(
        (options.refresh ?? []).map((path) =>
          client.invalidateQueries({ queryKey: [path], exact: true }),
        ),
      );
      setBusy(false);
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
      <ErrorBox error={action.error} />
      {action.busy && <p role="status">Working…</p>}
      {action.message && <p role="status">{action.message}</p>}
    </>
  );
}
export { DirtyGuard } from './navigation-guard';
