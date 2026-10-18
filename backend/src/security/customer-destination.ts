import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import type pg from 'pg';
export class DestinationError extends Error {
  readonly statusCode = 422;
  constructor(public readonly code: 'DESTINATION_NOT_ALLOWED' | 'TLS_REQUIRED') {
    super(code === 'TLS_REQUIRED' ? 'Verified TLS is required for customer databases' : 'Customer database destination is not allowed');
  }
}
export function publicAddress(address: string): boolean {
  try {
    // Reject mapped/transition ranges as well as local/private/reserved addresses.
    return address !== '168.63.129.16' && ipaddr.parse(address).range() === 'unicast';
  } catch { return false; }
}
export function destinationConfig(source: NodeJS.ProcessEnv = process.env) {
  const mode = source.CUSTOMER_DB_POLICY ?? (source.NODE_ENV === 'production' ? 'restricted' : 'development');
  if (!['restricted', 'development'].includes(mode) || (source.NODE_ENV === 'production' && mode !== 'restricted')) throw new Error('Invalid customer database policy mode');
  const destinations = new Set<string>();
  for (const item of (source.CUSTOMER_DB_ALLOWED_DESTINATIONS ?? '').split(',').map((v) => v.trim()).filter(Boolean)) {
    // DNS names only: no URL syntax, wildcard, IP literals, trailing dot or zone IDs.
    const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?):([1-9][0-9]{0,4})$/.exec(item);
    if (!match || isIP(match[1]!) || match[1]!.split('.').some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)) || Number(match[2]) > 65535) throw new Error('Invalid customer database destination allowlist');
    destinations.add(`${match[1]!.toLowerCase()}:${Number(match[2])}`);
  }
  return { mode, destinations };
}
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export async function customerConnectionOptions(options: pg.ClientConfig, source: NodeJS.ProcessEnv = process.env,
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true })): Promise<pg.ClientConfig> {
  const { mode, destinations } = destinationConfig(source);
  if (mode === 'development') return options;
  const hostname = options.host ?? '';
  const host = hostname.toLowerCase();
  if (!destinations.has(`${host}:${options.port ?? 5432}`)) throw new DestinationError('DESTINATION_NOT_ALLOWED');
  if (!options.ssl || (typeof options.ssl === 'object' && options.ssl.rejectUnauthorized === false)) throw new DestinationError('TLS_REQUIRED');
  let addresses: { address: string; family: number }[];
  // Bound DNS work independently of pg's connect timeout. The selected address
  // becomes pg's host so the socket never performs a second DNS lookup.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([resolve(host), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DestinationError('DESTINATION_NOT_ALLOWED')), 3000);
    })]);
  } catch { throw new DestinationError('DESTINATION_NOT_ALLOWED'); }
  finally { if (timer) clearTimeout(timer); }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new DestinationError('DESTINATION_NOT_ALLOWED');
  return { ...options, host: addresses[0]!.address, ssl: {
    ...(typeof options.ssl === 'object' ? options.ssl : {}), rejectUnauthorized: true, servername: host,
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
  } };
}
