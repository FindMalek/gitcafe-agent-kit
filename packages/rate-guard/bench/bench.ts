// Tiny, polite benchmark: 2 guarded agents x 14 cheap reads = 28 requests, ~2.8% of one minute's `api` budget.
// Transport is the `cafe` CLI so it uses the real logged-in account budget without touching the token.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGuard, type Reply } from '../src/guard.ts';

const PER_AGENT = Number(process.env.BENCH_REQUESTS ?? 14);
const PATH = process.env.BENCH_PATH ?? '/repos/versecafe/webls/';

function cafe(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const c = spawn('cafe', ['api', path, '--response-headers', '--no-update-check'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stdout.resume();
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', () => {
      const status = Number(/^HTTP (\d+)/m.exec(err)?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const l of err.split('\n')) {
        const i = l.indexOf(':');
        if (i > 0 && !l.startsWith('HTTP')) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status, headers });
    });
  });
}

const t0 = Date.now();
const sent: Record<string, number[]> = { A: [], B: [] };
const statuses: Record<string, number> = {};
const remainingHeaderSeen: string[] = [];
const waits: string[] = [];

const agent = (name: 'A' | 'B') =>
  createGuard<string>(
    async (p) => {
      sent[name].push(Date.now() - t0);
      const r = await cafe(p);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      for (const h of Object.keys(r.headers)) if (/^(ratelimit|x-ratelimit)/.test(h) && h !== 'ratelimit-policy') remainingHeaderSeen.push(`${h}=${r.headers[h]}`);
      return r;
    },
    { share: 0.01, onWait: (w) => w.ms > 2000 && waits.push(`${name}:${w.reason}:${Math.round(w.ms)}ms`) },
  );

const guards = { A: agent('A'), B: agent('B') };
await Promise.all((['A', 'B'] as const).flatMap((n) => Array.from({ length: PER_AGENT }, () => guards[n].request(PATH))));

const maxInWindow = (ts: number[]) => Math.max(...ts.map((t) => ts.filter((x) => x > t - 60_000 && x <= t).length));
const result = {
  path: PATH,
  requests: PER_AGENT * 2,
  elapsedMs: Date.now() - t0,
  statuses,
  maxRequestsInAny60sWindowPerAgent: { A: maxInWindow(sent.A), B: maxInWindow(sent.B) },
  configuredPerAgentCap: 10,
  learnedPolicies: guards.A.stats().policies,
  remainingQuotaHeaderOnSuccess: remainingHeaderSeen.length ? [...new Set(remainingHeaderSeen)] : 'none observed',
  longWaits: waits.length,
};
await mkdir('out', { recursive: true });
await writeFile('out/bench.json', JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
