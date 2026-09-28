import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { createApp } from './server.js';

describe('createApp', () => {
  it('serves GET /todos over an ephemeral port', async () => {
    const server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/todos`);
      await res.text();
      assert.equal(res.status, 200);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
