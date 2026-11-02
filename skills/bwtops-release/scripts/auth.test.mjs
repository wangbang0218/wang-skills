import assert from 'node:assert/strict';
import test from 'node:test';
import { LIST_URL, verifyToken } from './auth.mjs';

function fixture({ status = 200, body, error, invalidJson = false } = {}) {
  const calls = [];
  let disposed = false;
  const request = { async newContext(...args) {
    assert.deepEqual(args, []); // No storageState or browser cookies supplied.
    return {
      async get(url, options) {
        calls.push({ url, options });
        if (error) throw error;
        return { status: () => status, async json() {
          if (invalidJson) throw new Error('private response');
          return body;
        } };
      },
      async dispose() { disposed = true; },
    };
  } };
  return { request, calls, disposed: () => disposed };
}

test('validates via isolated GET with only X-Token, no redirects or credential output', async () => {
  const f = fixture({ body: { code: 200, data: { app_list: [{ secret: 'private-record' }], total: 22 } } });
  const result = await verifyToken('test-private-token', f.request);
  assert.deepEqual(result, { status: 'authenticated', httpStatus: 200, code: 200, total: 22, count: 1 });
  assert.deepEqual(f.calls, [{ url: LIST_URL, options: {
    headers: { 'X-Token': 'test-private-token' }, timeout: 15000, maxRedirects: 0,
  } }]);
  assert.equal(f.disposed(), true);
});

test('missing token never sends an HTTP request', async () => {
  assert.deepEqual(await verifyToken(null, {}), { status: 'auth_required' });
});

for (const code of [1001, 1002]) {
  test(`HTTP 200 with business code ${code} requires login`, async () => {
    const f = fixture({ body: { code, msg: 'private message' } });
    assert.deepEqual(await verifyToken('test-token', f.request), { status: 'auth_required', httpStatus: 200, code });
    assert.equal(f.disposed(), true);
  });
}

test('redirect, forbidden and server error are not reported as authenticated', async () => {
  for (const status of [302, 403, 500]) {
    const f = fixture({ status });
    assert.deepEqual(await verifyToken('test-token', f.request), { status: 'http_error', httpStatus: status });
  }
});

test('non-JSON and malformed success payload cannot pass authentication check', async () => {
  for (const setup of [{ invalidJson: true }, { body: { code: 200, data: {} } }]) {
    const f = fixture(setup);
    assert.equal((await verifyToken('test-token', f.request)).status, 'invalid_response');
  }
});

test('network failure stays separate from expired auth and suppresses raw error', async () => {
  const f = fixture({ error: new Error('request headers X-Token: private-value') });
  assert.deepEqual(await verifyToken('private-value', f.request), { status: 'network_error' });
  assert.equal(f.disposed(), true);
});
