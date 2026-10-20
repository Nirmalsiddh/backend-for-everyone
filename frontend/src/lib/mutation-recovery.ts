export function mutationRecovery(code: string, operation = '', status = 0) {
  if (/ GET$/.test(operation))
    return 'Could not refresh saved status. Refresh metadata when the service is available.';
  const uncertain =
    [
      'WRITE_OUTCOME_UNKNOWN',
      'INTERNAL_ERROR',
      'SCHEMA_OUTCOME_UNKNOWN',
      'AUTH_OUTCOME_UNKNOWN',
      'RESPONSE_UNCONFIRMED',
      'BACKEND_UNAVAILABLE',
      'BACKEND_CONTRACT_MISMATCH',
    ].includes(code) ||
    status === 504 ||
    status === 0;
  if (!uncertain) return '';
  const prefix =
    'The request may have completed even though the response was lost. Inspect the saved state before trying again. ';
  if (/schema.*apply/.test(operation) || code === 'SCHEMA_OUTCOME_UNKNOWN')
    return prefix + 'Review the schema operation before applying again.';
  if (/auth.*provision/.test(operation) || code === 'AUTH_OUTCOME_UNKNOWN')
    return (
      prefix +
      'Review authentication provisioning with the operator before creating tables again.'
    );
  if (/api-keys.*POST/.test(operation))
    return (
      prefix +
      'Refresh API keys. If a new key exists but its secret was not received, revoke it and create another.'
    );
  if (/api-keys.*DELETE/.test(operation))
    return (
      prefix + 'Refresh key metadata and confirm whether this key is revoked.'
    );
  if (/credentials/.test(operation))
    return (
      prefix +
      'Refresh connection state and retest saved credentials before submitting another update.'
    );
  if (/workflow.*publish/.test(operation))
    return (
      prefix + 'Refresh the published workflow version before publishing again.'
    );
  if (/workflow/.test(operation) && /PATCH/.test(operation))
    return (
      prefix + 'Refresh the workflow enabled state before changing it again.'
    );
  if (/signup/.test(operation))
    return (
      prefix + 'Try signing in with the same account before signing up again.'
    );
  return (
    prefix +
    'Inspect application state before repeating this request. Repeating it may create duplicate effects.'
  );
}
export function supportDetails(input: {
  projectId?: string;
  requestId?: string;
  timestamp?: string;
  operation?: string;
  code?: string;
  status?: number;
}) {
  const uuid = (v?: string) =>
    v &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
      ? v
      : undefined;
  const operation =
    input.operation &&
    /^(?:projects\/[a-f0-9-]{36}(?:\/[a-z0-9_/-]+)*|table:[a-f0-9-]{36}:(?:list|get|create|update|delete)|workflow:[a-f0-9-]{36}|auth:(?:signup|login|me|logout)) (?:GET|POST|PUT|PATCH|DELETE)$/.test(
      input.operation,
    )
      ? input.operation
      : undefined;
  return JSON.stringify(
    {
      projectId: uuid(input.projectId),
      requestId: uuid(input.requestId),
      timestamp:
        input.timestamp && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(input.timestamp)
          ? input.timestamp
          : undefined,
      operation,
      errorCode:
        input.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code)
          ? input.code
          : undefined,
      status:
        Number.isInteger(input.status) &&
        input.status! >= 0 &&
        input.status! <= 599
          ? input.status
          : undefined,
    },
    null,
    2,
  );
}
