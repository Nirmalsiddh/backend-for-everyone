export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  trustedDashboardProxy: string;
  connectionEncryptionKey: string;
  runtimeAllowedOrigins: string[];
}

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export function parseDatabaseUrl(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
    return value!;
  } catch {
    throw new Error(`${name} must be a PostgreSQL connection URL`);
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const portText = source.PORT ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = source.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be blank');
  const trustedDashboardProxy = source.TRUSTED_DASHBOARD_PROXY ?? '';
  if (trustedDashboardProxy && !['127.0.0.1', '::1'].includes(trustedDashboardProxy)) throw new Error('TRUSTED_DASHBOARD_PROXY must be an explicit loopback IP');
  const connectionEncryptionKey = source.CONNECTION_ENCRYPTION_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(connectionEncryptionKey)) {
    throw new Error('CONNECTION_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  const runtimeAllowedOrigins = (source.RUNTIME_ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const origin of runtimeAllowedOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error();
    } catch { throw new Error('RUNTIME_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins'); }
  }
  return {
    runtimeAllowedOrigins: [...new Set(runtimeAllowedOrigins)],
    connectionEncryptionKey,
    nodeEnv: nodeEnv as Env['nodeEnv'], host, port,
    databaseUrl: parseDatabaseUrl(source.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL'),
    trustedDashboardProxy,
  };
}
