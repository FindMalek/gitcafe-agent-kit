import { runIssue } from './runner.ts';

const a = process.argv.slice(2);
const flag = (n: string) => {
  const i = a.indexOf(`--${n}`);
  return i >= 0 ? a[i + 1] : undefined;
};
const sep = a.indexOf('--');
const agentCmd = sep >= 0 ? a.slice(sep + 1) : [];
const need = (n: string) => flag(n) ?? (() => { throw new Error(`--${n} is required`); })();
if (!agentCmd.length) throw new Error('usage: run --repo o/r --issue N --handle me --repo-dir . --agent-name x --model y [--base main] [--submit] [--no-comment] -- <agent argv...>');

const res = await runIssue({
  repo: need('repo'), issue: Number(need('issue')), handle: need('handle'), repoDir: need('repo-dir'), base: flag('base') ?? 'main',
  agentCmd, agentName: need('agent-name'), model: need('model'), submit: a.includes('--submit'), comment: !a.includes('--no-comment'),
  log: (m) => console.error(m),
});
console.log(JSON.stringify(res, null, 1));
process.exit(res.status === 'failed' || res.status === 'refused' ? 1 : 0);
