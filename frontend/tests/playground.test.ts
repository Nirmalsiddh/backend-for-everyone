import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestSequence, parseResponse } from '../src/lib/playground';
import { insertStep, newStep, reconcileAuth } from '../src/lib/workflow';
test('request invalidation suppresses late responses and aborts the wait', () => {
  const requests = new RequestSequence();
  const first = requests.start();
  requests.invalidate();
  assert.equal(first.signal.aborted, true);
  assert.equal(requests.current(first.id), false);
  const second = requests.start();
  assert.equal(requests.current(second.id), true);
});
test('JSON null, false, scalar and empty body stay distinct', () => {
  assert.deepEqual(parseResponse('null'), { empty: false, body: null });
  assert.deepEqual(parseResponse(''), { empty: true, body: null });
  assert.deepEqual(parseResponse('false'), { empty: false, body: false });
  assert.deepEqual(parseResponse('42'), { empty: false, body: 42 });
});
test('new steps insert before default response, explicit insertion preserves order', () => {
  const response = newStep('response', 'respond', 'key_only');
  const query = newStep('query', 'read', 'key_only');
  assert.deepEqual(
    insertStep([response], query).map((s) => s.name),
    ['read', 'respond'],
  );
  assert.deepEqual(
    insertStep([response], query, 1).map((s) => s.name),
    ['respond', 'read'],
  );
  assert.equal(
    (
      reconcileAuth([query], 'authenticated')[0] as typeof query & {
        access: { mode: string };
      }
    ).access.mode,
    'authenticated',
  );
});
