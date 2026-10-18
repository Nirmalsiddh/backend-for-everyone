import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
export function trustedProxyPeers(value: string) {
  const peers = value.split(',').map((v) => v.trim()).filter(Boolean);
  if (peers.some((peer) => !isIP(peer) || !['private', 'loopback', 'uniqueLocal'].includes(ipaddr.parse(peer).range()))) throw new Error('TRUSTED_PROXY_IPS must contain exact IP addresses');
  return peers;
}
