import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIssue, type Exec } from '../src/runner.ts';

function fake(issue: object, opts: { commits?: string; after?: object } = {}) {
  const calls: string[] = [];
  let views = 0;
  let stackName = '';
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.filter((x) => !['--agent', '--json', '--no-update-check'].includes(x)).join(' ')}`;
    calls.push(line);
    const env = (data: object) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: '' });
    if (line.includes('issue view')) return env({ resource: ++views === 1 ? issue : (opts.after ?? issue) });
    if (line.includes('rev-list')) return { code: 0, stdout: opts.commits ?? 'abc1234567890\n', stderr: '' };
    if (line.includes('stack submit') && !line.includes('--dry-run')) stackName = args[args.indexOf('--name') + 1];
    if (line.includes('stack submit') && !line.includes('--dry-run')) return env({ attempt: { number: 99 } });
    if (line.includes('pr list')) return env({ items: [{ number: 7, sourceBranch: `cafe/${stackName}/1` }, { number: 8, sourceBranch: `cafe/${stackName}/2` }, { number: 9, sourceBranch: 'someone/else' }] });
    return env({});
  };
  return { exec, calls };
}
const base = { repo: 'o/r', issue: 5, handle: 'bot', repoDir: '/tmp/x/repo', base: 'main', agentCmd: ['true'], agentName: 'a', model: 'm', submit: false, comment: true };

test('default stops after dry-run: nothing is published or commented', async () => {
  const f = fake({ state: 'open', title: 'Fix it', assignees: [] });
  const r = await runIssue({ ...base, exec: f.exec });
  assert.equal(r.status, 'dry-run-ok');
  assert.ok(f.calls.some((c) => c.includes('stack submit') && c.includes('--dry-run')));
  assert.ok(!f.calls.some((c) => c.includes('stack submit') && !c.includes('--dry-run')));
  assert.ok(!f.calls.some((c) => c.includes('issue comment')));
});

test('refuses an issue someone else holds, and detects a lost claim race', async () => {
  const taken = await runIssue({ ...base, exec: fake({ state: 'open', assignees: [{ handle: 'other' }] }).exec });
  assert.match(taken.reason!, /already assigned to other/);
  const race = await runIssue({ ...base, exec: fake({ state: 'open', assignees: [] }, { after: { state: 'open', assignees: ['other', 'bot'] } }).exec });
  assert.match(race.reason!, /lost the claim race/);
});

test('--submit: dry-run, real submit, links PRs, comments with provenance', async () => {
  const f = fake({ state: 'open', title: 'Fix it', assignees: [] });
  const r = await runIssue({ ...base, submit: true, exec: f.exec });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.prs, [7, 8], 'only PRs on the stack branches, never stray numbers from the submit JSON');
  const order = f.calls.map((c) => (c.includes('--dry-run') ? 'dry' : c.includes('stack submit') ? 'submit' : c.includes('pr link') ? 'link' : c.includes('issue comment') ? 'comment' : '')).filter(Boolean);
  assert.deepEqual(order, ['dry', 'submit', 'link', 'link', 'comment']);
});

test('refuses a closed issue', async () => {
  const r = await runIssue({ ...base, exec: fake({ closedAt: '2026-01-01', stateType: 'completed', assignees: [] }).exec });
  assert.equal(r.status, 'refused');
});

test('no commits from the agent fails before any submit', async () => {
  const f = fake({ state: 'open', assignees: [] }, { commits: '' });
  assert.equal((await runIssue({ ...base, submit: true, exec: f.exec })).reason, 'agent produced no commits');
  assert.ok(!f.calls.some((c) => c.includes('stack submit')));
});
