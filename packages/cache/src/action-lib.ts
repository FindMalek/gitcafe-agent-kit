import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { glob, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { S3Client } from './s3.ts';

export interface Inputs {
  paths: string[];
  key: string;
  restoreKeys: string[];
  prefix: string;
  failOnError: boolean;
  s3?: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
}

// the runner exposes `with:` inputs as INPUT_<NAME> (uppercased, spaces to underscores, hyphens kept)
const input = (env: NodeJS.ProcessEnv, name: string) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function parseInputs(env: NodeJS.ProcessEnv): Inputs {
  const bucket = input(env, 'bucket');
  const accessKeyId = input(env, 'access-key-id');
  const secretAccessKey = input(env, 'secret-access-key');
  const region = input(env, 'region') || 'auto';
  return {
    paths: lines(input(env, 'path')),
    key: input(env, 'key'),
    restoreKeys: lines(input(env, 'restore-keys')),
    prefix: input(env, 'prefix') || 'gitcafe-cache',
    failOnError: input(env, 'fail-on-error') === 'true',
    s3: bucket && accessKeyId && secretAccessKey ? { endpoint: input(env, 'endpoint') || `https://s3.${region}.amazonaws.com`, region, bucket, accessKeyId, secretAccessKey } : undefined,
  };
}

export const versionOf = (paths: string[]) => createHash('sha256').update([...paths].sort().join('\n')).digest('hex').slice(0, 12);
const objectKey = (i: Inputs, key: string) => `${i.prefix}/${versionOf(i.paths)}/${encodeURIComponent(key)}.tgz`;

export async function expandPaths(patterns: string[], cwd: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw;
    if (/[*?[\]{}]/.test(p)) for await (const m of glob(p, { cwd })) out.add(resolve(cwd, m));
    else if (existsSync(resolve(cwd, p))) out.add(resolve(cwd, p));
  }
  return [...out].sort();
}

function tar(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const c = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('error', rej);
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`tar ${args[0]} exited ${code}`))));
  });
}

export interface Io {
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export const runnerIo = (env = process.env): Io => ({
  env,
  log: (m) => console.log(m),
  warn: (m) => console.log(`::warning::${m}`),
});

function kv(file: string | undefined, k: string, v: string) {
  if (file) appendFileSync(file, `${k}=${v}\n`);
}

export async function restore(io: Io): Promise<void> {
  const inp = parseInputs(io.env);
  if (!inp.key || !inp.paths.length) throw new Error('`key` and `path` are required');
  const setOut = (k: string, v: string) => kv(io.env.GITHUB_OUTPUT, k, v);
  const setState = (k: string, v: string) => kv(io.env.GITHUB_STATE, k, v);
  setState('primary-key', inp.key);
  setOut('cache-hit', 'false');
  if (!inp.s3) {
    io.warn('gitcafe-cache: bucket / access-key-id / secret-access-key not set, cache disabled');
    setState('disabled', 'true');
    return;
  }
  const s3 = new S3Client(inp.s3);
  try {
    let matched: string | undefined;
    if (await s3.head(objectKey(inp, inp.key))) matched = inp.key;
    else {
      for (const rk of inp.restoreKeys) {
        const hits = (await s3.list(objectKey(inp, rk).replace(/\.tgz$/, ''))).filter((o) => o.key.endsWith('.tgz')).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        if (hits[0]) {
          matched = decodeURIComponent(hits[0].key.slice(hits[0].key.lastIndexOf('/') + 1, -'.tgz'.length));
          break;
        }
      }
    }
    if (!matched) return io.log(`Cache not found for key ${inp.key}`);
    const dir = join(tmpdir(), `gitcafe-cache-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'cache.tgz');
    const got = await s3.get(objectKey(inp, matched));
    if (!got) return io.log(`Cache not found for key ${inp.key}`);
    await pipeline(got.stream, createWriteStream(file));
    await tar(['-xzf', file, '-C', '/']);
    await rm(dir, { recursive: true, force: true });
    const exact = matched === inp.key;
    setOut('cache-hit', String(exact));
    setOut('cache-matched-key', matched);
    setState('exact-hit', String(exact));
    io.log(`Cache restored from key ${matched}${exact ? '' : ' (restore-key match, will save under the new key)'}`);
  } catch (e) {
    if (inp.failOnError) throw e;
    io.warn(`gitcafe-cache restore failed, continuing without cache: ${(e as Error).message}`);
  }
}

export async function save(io: Io, cwd = process.cwd()): Promise<void> {
  const inp = parseInputs(io.env);
  const state = (k: string) => io.env[`STATE_${k}`];
  if (state('disabled') === 'true') return;
  if (state('exact-hit') === 'true') return io.log(`Cache hit occurred on the primary key ${inp.key}, not saving`);
  if (!inp.s3) return;
  const s3 = new S3Client(inp.s3);
  try {
    const files = await expandPaths(inp.paths, cwd);
    if (!files.length) return io.warn(`gitcafe-cache: no files matched ${inp.paths.join(', ')}, nothing saved`);
    if (await s3.head(objectKey(inp, inp.key))) return io.log(`Key ${inp.key} already exists, not saving`);
    const dir = join(tmpdir(), `gitcafe-cache-${randomBytes(6).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    const list = join(dir, 'files.txt');
    await writeFile(list, files.map((f) => f.replace(/^\//, '')).join('\n') + '\n');
    const file = join(dir, 'cache.tgz');
    await tar(['-czf', file, '-C', '/', '-T', list]);
    const { size } = await stat(file);
    await s3.put(objectKey(inp, inp.key), createReadStream(file), size);
    await rm(dir, { recursive: true, force: true });
    io.log(`Cache saved with key ${inp.key} (${size} bytes, ${files.length} paths)`);
  } catch (e) {
    if (inp.failOnError) throw e;
    io.warn(`gitcafe-cache save failed: ${(e as Error).message}`);
  }
}
