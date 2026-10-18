import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialEncryption } from '../src/security/encryption.js';

const encryption = new CredentialEncryption('11'.repeat(32));

test('AES-GCM round trip uses fresh nonces and hides plaintext', () => {
  const config = { password: 'a-very-secret-password', host: 'customer.example' };
  const first = encryption.encrypt(config, 'project:connection');
  const second = encryption.encrypt(config, 'project:connection');
  assert.deepEqual(encryption.decrypt(first, 'project:connection'), config);
  assert.notEqual(first.encryptionIv, second.encryptionIv);
  assert.notEqual(first.encryptedConfig, second.encryptedConfig);
  assert.ok(!JSON.stringify(first).includes(config.password));
});

test('AES-GCM rejects tampering, wrong keys, context swaps, and unsupported formats', () => {
  const saved = encryption.encrypt({ password: 'secret' }, 'project:connection');
  for (const modified of [
    { ...saved, encryptedConfig: Buffer.from('tampered').toString('base64') },
    { ...saved, encryptionTag: Buffer.alloc(16).toString('base64') },
    { ...saved, encryptionIv: Buffer.alloc(12).toString('base64') },
    { ...saved, encryptionVersion: 2 },
  ]) assert.throws(() => encryption.decrypt(modified, 'project:connection'), { message: 'Credential decryption failed' });
  assert.throws(() => encryption.decrypt(saved, 'other-project:connection'));
  assert.throws(() => new CredentialEncryption('22'.repeat(32)).decrypt(saved, 'project:connection'));
  assert.throws(() => new CredentialEncryption('short'));
});
