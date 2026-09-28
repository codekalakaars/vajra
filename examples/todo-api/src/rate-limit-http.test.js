import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createApp } from './server.js';

function startServer(app) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      })
    }));
  });
}

describe('rate limiting over HTTP', () => {
  let running;

  beforeEach(async () => {
    running = await startServer(createApp({ rateLimit: { limit: 3, windowMs: 60_000 } }));
  });

  afterEach(() => running.close());

  it('serves the first requests up to the limit and returns 429 afterwards', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${running.baseUrl}/todos`);
      await res.text();
      statuses.push(res.status);
    }

    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });

  it('returns a JSON error body, Retry-After and rate limit headers when blocked', async () => {
    for (let i = 0; i < 3; i++) {
      await (await fetch(`${running.baseUrl}/todos`)).text();
    }

    const res = await fetch(`${running.baseUrl}/todos`);
    const body = await res.json();

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(body, { error: 'Too many requests' });
    assert.equal(res.headers.get('x-ratelimit-limit'), '3');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  });

  it('always answers CORS preflight requests with 204', async () => {
    for (let i = 0; i < 3; i++) {
      await (await fetch(`${running.baseUrl}/todos`)).text();
    }
    const blocked = await fetch(`${running.baseUrl}/todos`);
    await blocked.text();
    assert.equal(blocked.status, 429);

    const preflight = await fetch(`${running.baseUrl}/todos`, { method: 'OPTIONS' });
    await preflight.text();
    assert.equal(preflight.status, 204);
  });
});
