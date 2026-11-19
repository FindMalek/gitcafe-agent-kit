import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Storage } from './storage.ts';

export interface ServerOptions {
  storage: Storage;
  tokens: string[]; // accepted bearer tokens
  maxArtifactBytes?: number;
  log?: (line: string) => void;
}

const HASH = /^[a-fA-F0-9]+$/;
const TEAM = /^[A-Za-z0-9_.-]{1,64}$/;

function tokenOk(header: string | undefined, tokens: string[]): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  return tokens.some((t) => {
    const want = Buffer.from(t);
    return want.length === got.length && timingSafeEqual(want, got);
  });
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) return res.writeHead(status).end();
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Implements the Turborepo Remote Cache API (https://turborepo.com/api/remote-cache-spec) under /v8. */
export function createCacheServer(opts: ServerOptions): Server {
  const max = opts.maxArtifactBytes ?? 1024 ** 3;
  const log = opts.log ?? (() => {});
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (!tokenOk(req.headers.authorization, opts.tokens)) return send(res, 401, { code: 'unauthorized', message: 'missing or invalid bearer token' });

      const team = url.searchParams.get('teamId') || url.searchParams.get('slug') || 'default';
      if (!TEAM.test(team)) return send(res, 400, { code: 'bad_team', message: 'invalid teamId/slug' });
      const m = /^\/v8\/artifacts(?:\/([^/]+))?$/.exec(url.pathname);
      if (!m) return send(res, 404, { code: 'not_found', message: 'unknown route' });
      const [, seg] = m;
      const method = req.method ?? 'GET';

      if (!seg && method === 'POST') {
        const body = (await readJson(req)) as { hashes?: unknown };
        if (!Array.isArray(body.hashes) || !body.hashes.every((h) => typeof h === 'string' && HASH.test(h))) return send(res, 400, { code: 'bad_request', message: 'hashes must be hex strings' });
        const out: Record<string, unknown> = {};
        for (const h of body.hashes as string[]) {
          const found = await opts.storage.head(`${team}/${h}`);
          out[h] = found ? { size: found.size, taskDurationMs: Number(found.meta.duration ?? 0), tag: found.meta.tag } : null;
        }
        return send(res, 200, out);
      }
      if (seg === 'status' && method === 'GET') return send(res, 200, { status: 'enabled' });
      if (seg === 'events' && method === 'POST') {
        await readJson(req).catch(() => {});
        return send(res, 200, {});
      }
      if (!seg || !HASH.test(seg)) return send(res, 400, { code: 'bad_hash', message: 'artifact hash must be hex' });
      const key = `${team}/${seg}`;

      if (method === 'HEAD' || method === 'GET') {
        const found = method === 'HEAD' ? await opts.storage.head(key) : await opts.storage.get(key);
        if (!found) return send(res, 404, { code: 'cache_miss', message: 'artifact not found' });
        const h: Record<string, string | number> = { 'content-length': found.size, 'content-type': 'application/octet-stream' };
        if (found.meta.duration) h['x-artifact-duration'] = found.meta.duration;
        if (found.meta.tag) h['x-artifact-tag'] = found.meta.tag;
        res.writeHead(200, h);
        if ('stream' in found) {
          found.stream.on('error', () => res.destroy());
          found.stream.pipe(res);
        } else res.end();
        log(`${method} ${key} 200`);
        return;
      }
      if (method === 'PUT') {
        const size = Number(req.headers['content-length']);
        if (!Number.isInteger(size) || size < 0) return send(res, 400, { code: 'length_required', message: 'Content-Length required' });
        if (size > max) return send(res, 413, { code: 'too_large', message: `artifact exceeds ${max} bytes` });
        const dur = req.headers['x-artifact-duration'];
        const tag = req.headers['x-artifact-tag'];
        await opts.storage.put(key, req, size, { duration: typeof dur === 'string' ? dur : undefined, tag: typeof tag === 'string' ? tag : undefined });
        log(`PUT ${key} ${size}B 202`);
        return send(res, 202, { urls: [`${url.origin}/v8/artifacts/${seg}`] });
      }
      return send(res, 405, { code: 'method_not_allowed', message: method });
    } catch (e) {
      log(`error ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { code: 'internal', message: 'internal error' });
      else res.destroy();
    }
  });
}
