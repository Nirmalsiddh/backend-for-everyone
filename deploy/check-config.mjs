import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const config = JSON.parse(execFileSync('docker', ['compose', '--profile', 'tools', '--env-file', 'deploy/env.example', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], { encoding: 'utf8' }));
for (const [name, service] of Object.entries(config.services)) {
  if (name !== 'caddy') assert.equal(service.ports?.length ?? 0, 0, `${name} must not publish ports`);
}
assert.deepEqual(config.services.caddy.ports.map((p) => String(p.published)).sort(), ['443', '80']);
assert.equal(config.networks.database.internal, true);
assert.ok(!config.services.frontend.networks.database);
assert.match(config.services.backend.environment.PLATFORM_DATABASE_URL, /platform_app:/);
assert.match(config.services.migrate.environment.PLATFORM_DATABASE_URL, /platform_migrator:/);
console.log('Compose publication, network isolation and database role checks passed');
