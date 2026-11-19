import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCacheServer } from '../src/server.ts';
import { FsStorage } from '../src/storage.ts';
import { signV4 } from '../src/s3.ts';

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'tc-'));
  const server = createCacheServer({ storage: new FsStorage(dir), tokens: ['secret'], maxArtifactBytes: 1000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}
const auth = { authorization: 'Bearer secret' };

test('round trip put/head/get/query, team isolation, auth, limits', async () => {
  const { base, close } = await boot();
  try {
    const body = Buffer.from('tarball-bytes');
    const put = await fetch(`${base}/v8/artifacts/abc123?slug=t1`, { method: 'PUT', headers: { ...auth, 'x-artifact-duration': '42', 'x-artifact-tag': 'sig' }, body });
    assert.equal(put.status, 202);
    const get = await fetch(`${base}/v8/artifacts/abc123?slug=t1`, { headers: auth });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('x-artifact-tag'), 'sig');
    assert.equal(Buffer.from(await get.arrayBuffer()).toString(), 'tarball-bytes');
    assert.equal((await fetch(`${base}/v8/artifacts/abc123?slug=t2`, { headers: auth })).status, 404, 'other team must miss');
    const q = await (await fetch(`${base}/v8/artifacts?slug=t1`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ hashes: ['abc123', 'ffff'] }) })).json();
    assert.deepEqual(q, { abc123: { size: body.length, taskDurationMs: 42, tag: 'sig' }, ffff: null });
    assert.equal((await fetch(`${base}/v8/artifacts/abc123`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${base}/v8/artifacts/not-hex?slug=t1`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/v8/artifacts/ab?slug=../x`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/v8/artifacts/dd`, { method: 'PUT', headers: auth, body: Buffer.alloc(2000) })).status, 413);
    assert.deepEqual(await (await fetch(`${base}/v8/artifacts/status`, { headers: auth })).json(), { status: 'enabled' });
  } finally {
    close();
  }
});

test('sigv4 matches the AWS documented GET object example', () => {
  const h = signV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {}, headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    cfg: { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});
