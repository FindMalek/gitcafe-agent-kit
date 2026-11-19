import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (cmd, args, opts) =>
  new Promise((res) => {
    execFile(cmd, args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      res({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) || 1 : 0, stdout, stderr });
    });
  });

export interface RunOptions {
  repo: string; // owner/name
  issue: number;
  handle: string; // account the agent acts as (becomes the assignee)
  repoDir: string; // existing local clone
  base: string;
  agentCmd: string[]; // argv; receives ISSUE_* env vars and runs inside the worktree
  agentName: string;
  model: string;
  submit: boolean; // false = stop after `stack submit --dry-run`
  comment: boolean;
  exec?: Exec;
  log?: (m: string) => void;
}

export interface RunResult {
  status: 'done' | 'dry-run-ok' | 'refused' | 'failed';
  reason?: string;
  worktree?: string;
  branch?: string;
  commits?: string[];
  prs?: number[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';

interface CafeEnvelope {
  data?: any;
}

export async function runIssue(o: RunOptions): Promise<RunResult> {
  const exec = o.exec ?? realExec;
  const log = o.log ?? (() => {});
  const cafe = async (args: string[], cwd?: string) => {
    const r = await exec('cafe', ['--agent', '--json', '--no-update-check', '-R', o.repo, ...args], { cwd });
    let json: CafeEnvelope = {};
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { ...r, json };
  };
  const fail = (reason: string, extra: Partial<RunResult> = {}): RunResult => ({ status: 'failed', reason, ...extra });

  // 1. read the issue
  const view = await cafe(['issue', 'view', String(o.issue)]);
  if (view.code !== 0) return fail(`issue view failed: ${view.stdout.slice(0, 300) || view.stderr.slice(0, 300)}`);
  const issue = view.json.data?.resource ?? view.json.data?.issue ?? view.json.data ?? {};
  if (issue.closedAt || ['completed', 'canceled'].includes(issue.stateType)) return { status: 'refused', reason: `issue is closed (${issue.stateType ?? 'closedAt set'})` };
  const assignees: string[] = (issue.assignees ?? []).map((a: any) => (typeof a === 'string' ? a : (a.handle ?? a.login ?? '')));
  const others = assignees.filter((h) => h && h !== o.handle);
  if (others.length) return { status: 'refused', reason: `already assigned to ${others.join(', ')}` };

  // 2. claim: no server-side lease exists, so assign then re-read and make sure we are the only assignee
  if (!assignees.includes(o.handle)) {
    const a = await cafe(['issue', 'assign', String(o.issue), o.handle]);
    if (a.code !== 0) return fail(`assign failed: ${a.stdout.slice(0, 300)}`);
    const again = await cafe(['issue', 'view', String(o.issue)]);
    const now: string[] = ((again.json.data?.resource ?? again.json.data?.issue ?? again.json.data ?? {}).assignees ?? []).map((x: any) => (typeof x === 'string' ? x : (x.handle ?? '')));
    if (now.some((h) => h && h !== o.handle)) return { status: 'refused', reason: `lost the claim race to ${now.filter((h) => h !== o.handle).join(', ')}` };
  }
  log(`claimed #${o.issue}`);

  // 3. isolated worktree on a fresh branch
  const run = randomBytes(3).toString('hex');
  const branch = `agent/issue-${o.issue}-${slug(String(issue.title ?? ''))}-${run}`;
  const worktree = resolve(dirname(resolve(o.repoDir)), `${o.repoDir.split('/').filter(Boolean).pop()}-wt-issue-${o.issue}-${run}`);
  await mkdir(dirname(worktree), { recursive: true });
  const wt = await exec('git', ['-C', o.repoDir, 'worktree', 'add', '-b', branch, worktree, o.base]);
  if (wt.code !== 0) return fail(`git worktree add failed: ${wt.stderr.slice(0, 300)}`);

  // 4. run the agent inside it
  const env = { ISSUE_NUMBER: String(o.issue), ISSUE_TITLE: String(issue.title ?? ''), ISSUE_BODY: String(issue.description ?? issue.body ?? ''), ISSUE_REPO: o.repo, ISSUE_BRANCH: branch };
  const ag = await exec(o.agentCmd[0], o.agentCmd.slice(1), { cwd: worktree, env });
  if (ag.code !== 0) return fail(`agent exited ${ag.code}: ${ag.stderr.slice(0, 300)}`, { worktree, branch });
  const revs = await exec('git', ['-C', worktree, 'rev-list', '--reverse', `${o.base}..HEAD`]);
  const commits = revs.stdout.split('\n').filter(Boolean);
  if (!commits.length) return fail('agent produced no commits', { worktree, branch });

  // 5. dry run first, always
  const name = `agent-issue-${o.issue}-${run}`;
  const dry = await cafe(['stack', 'submit', '--name', name, '--base', o.base, '--dry-run'], worktree);
  if (dry.code !== 0) return fail(`stack submit --dry-run failed: ${dry.stdout.slice(0, 400)}`, { worktree, branch, commits });
  if (!o.submit) return { status: 'dry-run-ok', worktree, branch, commits };

  // 6. real submit, link PRs, leave provenance
  const sub = await cafe(['stack', 'submit', '--name', name, '--base', o.base], worktree);
  if (sub.code !== 0) return fail(`stack submit failed: ${sub.stdout.slice(0, 400)}`, { worktree, branch, commits });
  // submit's JSON schema is undocumented; the stack's pull requests are the ones on branches `cafe/<name>/<n>`
  const listed = await cafe(['pr', 'list']);
  const prs: number[] = (listed.json.data?.items ?? []).filter((p: any) => String(p.sourceBranch ?? '').startsWith(`cafe/${name}/`)).map((p: any) => p.number as number);
  if (!prs.length) return fail('submit succeeded but no pull request was found on the stack branches', { worktree, branch, commits });
  const linked: number[] = [];
  for (const n of prs) {
    const l = await cafe(['pr', 'link', String(n), String(o.issue), '--type', 'closes']);
    if (l.code === 0) linked.push(n);
    else log(`pr link ${n} failed: ${l.stdout.slice(0, 200)}`);
  }
  if (o.comment) {
    const body = provenance({ ...o, branch, commits, prs: linked, run });
    await cafe(['issue', 'comment', String(o.issue), '--body', body]);
  }
  return { status: 'done', worktree, branch, commits, prs: linked };
}

export function provenance(p: { agentName: string; model: string; branch: string; commits: string[]; prs: number[]; run: string; issue: number }): string {
  return [
    `Opened by an automated run for #${p.issue}.`,
    '',
    `- agent: ${p.agentName}`,
    `- model: ${p.model}`,
    `- run: ${p.run}`,
    `- branch: \`${p.branch}\``,
    `- commits: ${p.commits.map((c) => `\`${c.slice(0, 9)}\``).join(', ')}`,
    `- pull requests: ${p.prs.length ? p.prs.map((n) => `#${n}`).join(', ') : 'none reported by submit'}`,
  ].join('\n');
}

export const joinPath = join;
