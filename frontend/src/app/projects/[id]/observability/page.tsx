'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { ErrorBox, State } from '@/components/ui';
import { CopyButton } from '@/components/copy-button';
import { validRequestId, type RequestEvent, type EventPage, type Summary } from '@/lib/observability';
const ms = (value: number | null) => value === null ? '—' : `${value.toFixed(2)} ms`;
function Requests({ title, items, select }: { title: string; items: RequestEvent[]; select: (event: RequestEvent) => void }) {
  return <section><h2>{title}</h2><table><caption>{title}</caption><thead><tr><th>Completed</th><th>Operation</th><th>Resource</th><th>Status</th><th>Duration</th><th>Request</th></tr></thead><tbody>
    {items.map((event) => <tr key={event.id}><td>{new Date(event.completedAt).toLocaleString()}</td><td>{event.operation ?? event.routeCategory}</td><td>{event.resource ?? '—'}</td><td>{event.status}</td><td>{ms(event.durationMs)}</td><td><button onClick={() => select(event)}>Inspect {event.requestId}</button></td></tr>)}
  </tbody></table>{!items.length && <p>No matching requests.</p>}</section>;
}
function Observability({ projectId }: { projectId: string }) {
  const [window, setWindow] = useState('24h');
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestEvent | null>(null);
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState('');
  const [filter, setFilter] = useState({ operation: '', resource: '', statusClass: '' });
  const base = `projects/${projectId}/observability`;
  const query = new URLSearchParams({ window });
  for (const [key,value] of Object.entries(filter)) if (value) query.set(key,value);
  if (cursor) query.set('cursor',cursor);
  const summary = useQuery({ queryKey: ['observability',projectId,'summary',window], queryFn: () => api<Summary>(`${base}/summary?window=${window}`) });
  const recent = useQuery({ queryKey: ['observability',projectId,'requests',query.toString()], queryFn: () => api<EventPage>(`${base}/requests?${query}`) });
  const failures = useQuery({ queryKey: ['observability',projectId,'failures',window], queryFn: () => api<EventPage>(`${base}/requests?window=${window}&failuresOnly=true`) });
  const result = useQuery({ queryKey: ['observability',projectId,'lookup',lookup], queryFn: () => api<{ items: RequestEvent[] }>(`${base}/requests/${lookup}`), enabled: !!lookup, retry: false });
  return <>
    <h1>Observability</h1>
    <p>Best-effort, near-real-time runtime history retained for approximately seven days.</p>
    <label>Time window<select value={window} onChange={(e) => { setWindow(e.target.value); setCursor(null); setDetail(null); }}><option value="1h">1 hour</option><option value="24h">24 hours</option><option value="7d">7 days</option></select></label>
    <button disabled={summary.isFetching || recent.isFetching || failures.isFetching} onClick={() => { void summary.refetch(); void recent.refetch(); void failures.refetch(); if (lookup) void result.refetch(); }}>Refresh</button>
    <State query={summary}>{summary.data && <>
      {summary.data.recordedRequests === 0 && <p>No runtime requests recorded yet.</p>}
      <dl>{(['Recorded requests','2xx','3xx','4xx','5xx','p50','p95'] as const).map((label) => <div key={label}><dt>{label}</dt><dd>{label === 'Recorded requests' ? summary.data!.recordedRequests : label === 'p50' ? ms(summary.data!.p50DurationMs) : label === 'p95' ? ms(summary.data!.p95DurationMs) : summary.data![label]}</dd></div>)}</dl>
      <h2>Top operations</h2><table><thead><tr><th>Resource</th><th>Operation</th><th>Recorded requests</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>p95</th></tr></thead><tbody>{summary.data.topOperations.map((op,i) => <tr key={i}><td>{op.resource ?? '—'}</td><td>{op.operation ?? 'Unresolved'}</td><td>{op.recordedRequests}</td><td>{op['2xx']}</td><td>{op['3xx']}</td><td>{op['4xx']}</td><td>{op['5xx']}</td><td>{ms(op.p95DurationMs)}</td></tr>)}</tbody></table>
      <h2>Public error codes</h2><table><thead><tr><th>Code</th><th>Responses</th></tr></thead><tbody>{summary.data.topErrorCodes.map((error) => <tr key={error.errorCode}><td>{error.errorCode}</td><td>{error.count}</td></tr>)}</tbody></table>
    </>}</State>
    <form onSubmit={(e) => { e.preventDefault(); setDetail(null); setLookup(search.trim()); }}><label>Exact request ID<input required pattern="[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}" value={search} onChange={(e) => setSearch(e.target.value)} /></label><button disabled={!validRequestId(search.trim()) || result.isFetching}>Find request</button></form>
    {lookup && <>{result.isPending && <p role="status">Finding request…</p>}{result.error instanceof ApiError && result.error.status === 404 ? <p>No retained request found.</p> : <ErrorBox error={result.error} />}{result.data && <Requests title="Request ID matches" items={result.data.items} select={setDetail} />}</>}
    {detail && <section aria-label="Request details"><h2>Request details</h2><button onClick={() => setDetail(null)}>Close details</button><CopyButton text={detail.requestId} label="Copy request ID" /><dl>{[['Request ID',detail.requestId],['Completed',detail.completedAt],['Method',detail.method],['Operation',detail.operation],['Resource',detail.resource],['Status',detail.status],['Error code',detail.errorCode],['Duration',ms(detail.durationMs)],['Response bytes',detail.responseBytes],['Principal kind',detail.principalKind]].map(([label,value]) => <div key={String(label)}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl></section>}
    <State query={failures}>{failures.data && <Requests title="Recent 4xx/5xx responses" items={failures.data.items} select={setDetail} />}</State>
    <fieldset><legend>Recent request filters</legend><label>Operation<select value={filter.operation} onChange={(e) => { setFilter({ ...filter, operation: e.target.value }); setCursor(null); }}><option value="">All</option>{['crud.list','crud.get','crud.create','crud.update','crud.delete','auth.signup','auth.login','auth.me','auth.logout','workflow.execute'].map((op) => <option key={op}>{op}</option>)}</select></label><label>Resource<input value={filter.resource} maxLength={100} onChange={(e) => { setFilter({ ...filter, resource: e.target.value }); setCursor(null); }} /></label><label>Status class<select value={filter.statusClass} onChange={(e) => { setFilter({ ...filter, statusClass: e.target.value }); setCursor(null); }}><option value="">All</option>{['2','3','4','5'].map((s) => <option key={s} value={s}>{s}xx</option>)}</select></label></fieldset>
    <State query={recent}>{recent.data && <Requests title="Recent requests" items={recent.data.items} select={setDetail} />}</State>
    <button disabled={!cursor} onClick={() => setCursor(null)}>Newest requests</button><button disabled={!recent.data?.nextCursor || recent.isFetching} onClick={() => setCursor(recent.data?.nextCursor ?? null)}>Next page</button>
    <p>Latency measures server handling through response completion. Response bytes describe application payload size, not network delivery. 4xx responses are distinct from server failures.</p>
  </>;
}
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <Observability key={id} projectId={id} />;
}
