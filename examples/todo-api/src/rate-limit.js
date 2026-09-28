/**
 * Rate limiting for the todo API.
 *
 * Contract:
 *
 * createRateLimiter(options) accepts `{ limit, windowMs }`, where both fields
 * are optional and default to RATE_LIMIT_DEFAULT_LIMIT and
 * RATE_LIMIT_DEFAULT_WINDOW_MS respectively. It returns a function
 * `check(key)` which takes an opaque string `key` (typically a client
 * identifier) and returns `{ allowed, limit, remaining, resetAt, retryAfterSeconds }`:
 *
 *   - `allowed` is true when the request fits inside the current window.
 *   - `limit` is the configured maximum number of requests per window.
 *   - `remaining` counts the requests still permitted in the current window
 *     after this one.
 *   - `resetAt` is a `Date.now()` millisecond timestamp at which the current
 *     window rolls over.
 *   - `retryAfterSeconds` is 0 when `allowed` is true.
 *
 * getOrCreateLimiter(options) memoises one limiter per options object identity
 * using a WeakMap: two calls with the same object share counters, while two
 * calls with different objects are independent of each other.
 *
 * The check() returned by this stub still always answers `allowed: true` and
 * performs no counting; a later task adds the counting.
 */
export const RATE_LIMIT_DEFAULT_LIMIT = 100;
export const RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;

export function createRateLimiter(options = {}) {
  const limit = options.limit ?? RATE_LIMIT_DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? RATE_LIMIT_DEFAULT_WINDOW_MS;

  return function check(key) {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt: Date.now() + windowMs,
      retryAfterSeconds: 0
    };
  };
}

// One limiter per options object, so every request handled by a single createApp() shares the same counters.
const limitersByOptions = new WeakMap();
const SHARED_OPTIONS = {};

export function getOrCreateLimiter(options = SHARED_OPTIONS) {
  const key = typeof options === 'object' && options !== null ? options : SHARED_OPTIONS;
  let limiter = limitersByOptions.get(key);
  if (!limiter) {
    limiter = createRateLimiter(key);
    limitersByOptions.set(key, limiter);
  }
  return limiter;
}
