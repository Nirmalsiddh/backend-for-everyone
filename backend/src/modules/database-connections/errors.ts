export class ConnectionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionTestCode =
  | 'AUTHENTICATION_FAILED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'SCHEMA_UNAVAILABLE';

const messages: Record<ConnectionTestCode, string> = {
  AUTHENTICATION_FAILED: 'Database authentication failed',
  CONNECTION_FAILED: 'Could not connect to the database',
  CONNECTION_TIMEOUT: 'Database connection test timed out',
  SCHEMA_UNAVAILABLE: 'Requested database schema is unavailable',
};

export function connectionTestError(code: ConnectionTestCode) {
  return new ConnectionError(
    code === 'CONNECTION_TIMEOUT' ? 504 : 422,
    code,
    messages[code],
  );
}
