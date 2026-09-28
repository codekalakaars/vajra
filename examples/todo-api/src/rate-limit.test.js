import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  it('allows requests up to the limit and blocks the next one', () => {
    const check = createRateLimiter({ limit: 3, windowMs: 60_000 });

    assert.equal(check('1.2.3.4').allowed, true);
    assert.equal(check('1.2.3.4').allowed, true);
    assert.equal(check('1.2.3.4').allowed, true);

    const blocked = check('1.2.3.4');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  it('counts each key separately', () => {
    const check = createRateLimiter({ limit: 1, windowMs: 60_000 });

    assert.equal(check('10.0.0.1').allowed, true);
    assert.equal(check('10.0.0.1').allowed, false);
    assert.equal(check('10.0.0.2').allowed, true);
    assert.equal(check('10.0.0.2').allowed, false);
  });

  it('reports the remaining count and the window reset time', () => {
    const before = Date.now();
    const check = createRateLimiter({ limit: 2, windowMs: 60_000 });

    assert.equal(check('a').remaining, 1);
    const second = check('a');
    assert.equal(second.remaining, 0);
    assert.equal(second.limit, 2);
    assert.ok(second.resetAt >= before + 60_000);
  });

  it('allows requests again once the window has elapsed', async () => {
    const check = createRateLimiter({ limit: 1, windowMs: 30 });

    assert.equal(check('k').allowed, true);
    assert.equal(check('k').allowed, false);

    await delay(50);

    assert.equal(check('k').allowed, true);
  });
});
