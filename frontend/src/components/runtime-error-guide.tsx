import { errorGuidance } from '@/lib/runtime-guidance';
export function RuntimeErrorGuide() {
  return (
    <details>
      <summary>If a runtime request fails</summary>
      <dl>
        {[400, 401, 403, 404, 409, 429, 503, 504].map((status) => (
          <div key={status}>
            <dt>{status}</dt>
            <dd>{errorGuidance(status, 'public')}</dd>
          </div>
        ))}
      </dl>
      <p>If something fails, copy the request ID when contacting support.</p>
    </details>
  );
}
