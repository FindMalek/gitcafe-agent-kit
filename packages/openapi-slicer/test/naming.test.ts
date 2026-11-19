import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameOperation } from '../src/naming.ts';
import { slice, danglingRefs } from '../src/slice.ts';

test('headline verb-style names', () => {
  assert.equal(nameOperation('get', '/api/repos/{owner}/{repo}/pulls/'), 'listPullRequests');
  assert.equal(nameOperation('get', '/api/repos/{owner}/{repo}/pulls/{pr}'), 'getPullRequest');
  assert.equal(nameOperation('post', '/api/repos/{owner}/{repo}/pulls/{pr}/merge'), 'mergePullRequest');
  assert.equal(nameOperation('delete', '/api/repos/{owner}/{repo}/issues/{issue}/lock'), 'unlockIssue');
});

test('lock file wins over recomputation and slices resolve all refs', () => {
  const spec = {
    openapi: '3.1.2', info: { title: 't', version: '1' }, servers: [],
    components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { type: 'string' } } },
    paths: { '/api/repos/{owner}/{repo}/pulls/': { get: { operationId: 'x', tags: ['PR'], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } },
  };
  const r = slice(spec, { 'get /api/repos/{owner}/{repo}/pulls/': 'pinnedName' });
  assert.equal(r.ops[0].id, 'pinnedName');
  assert.deepEqual(danglingRefs(r.slices.get('PR')), []);
  assert.ok(r.slices.get('PR').components.schemas.B);
});
