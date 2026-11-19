import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, parsePolicies, type Reply } from '../src/guard.ts';

const ok = (h: Record<string, string> = {}): Reply => ({ status: 200, headers: { 'ratelimit-policy': '"api";q=100;w=60', ...h } });

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
}

test('parses multi-policy headers', () => {
  assert.deepEqual(parsePolicies('"api";q=1000;w=60, "api-heavy";q=120;w=60'), [
    { name: 'api', quota: 1000, windowSeconds: 60 },
    { name: 'api-heavy', quota: 120, windowSeconds: 60 },
  ]);
});

test('share 10% of learned policy: never more than 10 requests in any 60s window, no 429s', async () => {
  const c = clock();
  const times: number[] = [];
  const g = createGuard<string>(async () => (times.push(c.at()), ok()), { share: 0.1, now: c.now, sleep: c.sleep });
  await Promise.all(Array.from({ length: 35 }, (_, i) => g.request(String(i))));
  for (const t of times) assert.ok(times.filter((x) => x > t - 60_000 && x <= t).length <= 10, `window at ${t}`);
  assert.equal(g.stats().policies[0].quota, 100);
  assert.ok(c.at() >= 150_000, 'had to wait for refill');
});

test('a 429 pauses the whole agent for Retry-After, then retries', async () => {
  const c = clock();
  let n = 0;
  const g = createGuard<string>(async () => (++n === 1 ? { status: 429, headers: { 'retry-after': '17', ratelimit: '"api-heavy";r=0;t=17' } } : ok()), { share: 1, now: c.now, sleep: c.sleep });
  const [a, b] = await Promise.all([g.request('a'), g.request('b')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(c.at() >= 17_000 && c.at() < 18_000, `waited ${c.at()}`);
  assert.equal(g.stats().throttled429, 1);
});

test('heavy requests spend both buckets', async () => {
  const c = clock();
  const g = createGuard<string>(async () => ok({ 'ratelimit-policy': '"api";q=1000;w=60, "api-heavy";q=10;w=60' }), { share: 1, extraPolicies: (r) => (r === 'h' ? ['api-heavy'] : []), now: c.now, sleep: c.sleep });
  await g.request('warm');
  for (let i = 0; i < 11; i++) await g.request('h');
  assert.ok(c.at() >= 5_000, `11 heavy calls on a 10/60s bucket must wait, waited ${c.at()}`);
});
