import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';

export interface S3Config {
  endpoint: string; // e.g. https://<account>.r2.cloudflarestorage.com or http://127.0.0.1:9000
  region: string; // 'auto' for R2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const sha256 = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p: string) => p.split('/').map(enc).join('/');

export function signV4(opts: {
  method: string;
  host: string;
  path: string; // already-encoded absolute path
  query: Record<string, string>;
  headers: Record<string, string>; // lowercase names, extra signed headers (x-amz-*)
  payloadHash: string;
  cfg: S3Config;
  now?: Date;
}): Record<string, string> {
  const { cfg } = opts;
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: opts.host, 'x-amz-content-sha256': opts.payloadHash, 'x-amz-date': amzDate };
  if (cfg.sessionToken) headers['x-amz-security-token'] = cfg.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(opts.query)
    .sort()
    .map((k) => `${enc(k)}=${enc(opts.query[k])}`)
    .join('&');
  const canonicalRequest = [opts.method, opts.path, canonicalQuery, canonicalHeaders, signedHeaders, opts.payloadHash].join('\n');
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretAccessKey, date), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

export class S3Error extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class S3Client {
  readonly cfg: S3Config;
  constructor(cfg: S3Config) {
    this.cfg = { ...cfg, endpoint: cfg.endpoint.replace(/\/+$/, '') };
  }

  private send(method: string, key: string, query: Record<string, string>, extra: Record<string, string>, body?: Readable | Buffer, size?: number): Promise<http.IncomingMessage> {
    const url = new URL(this.cfg.endpoint);
    const path = `${url.pathname.replace(/\/$/, '')}/${enc(this.cfg.bucket)}${key ? '/' + encPath(key) : ''}`;
    const unsigned = body && !Buffer.isBuffer(body);
    const payloadHash = Buffer.isBuffer(body) ? sha256(body) : unsigned ? 'UNSIGNED-PAYLOAD' : sha256('');
    const headers = signV4({ method, host: url.host, path, query, headers: extra, payloadHash, cfg: this.cfg });
    if (size !== undefined) headers['content-length'] = String(size);
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request({ method, hostname: url.hostname, port: url.port || undefined, path: path + (qs ? '?' + qs : ''), headers }, resolve);
      req.on('error', reject);
      if (!body) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        body.on('error', (e) => req.destroy(e));
        body.pipe(req);
      }
    });
  }

  private async text(res: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  async put(key: string, body: Readable | Buffer, size: number, meta: Record<string, string> = {}): Promise<void> {
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) extra[`x-amz-meta-${k.toLowerCase()}`] = v;
    const res = await this.send('PUT', key, {}, extra, body, size);
    const text = await this.text(res);
    if (res.statusCode! >= 300) throw new S3Error(res.statusCode!, `PUT ${key}: ${res.statusCode} ${text.slice(0, 200)}`);
  }

  async head(key: string): Promise<{ size: number; meta: Record<string, string> } | null> {
    const res = await this.send('HEAD', key, {}, {});
    res.resume();
    if (res.statusCode === 404) return null;
    if (res.statusCode! >= 300) throw new S3Error(res.statusCode!, `HEAD ${key}: ${res.statusCode}`);
    return { size: Number(res.headers['content-length'] ?? 0), meta: metaOf(res) };
  }

  /** Caller must consume or destroy the returned stream. */
  async get(key: string): Promise<{ stream: http.IncomingMessage; size: number; meta: Record<string, string> } | null> {
    const res = await this.send('GET', key, {}, {});
    if (res.statusCode === 404) {
      res.resume();
      return null;
    }
    if (res.statusCode! >= 300) throw new S3Error(res.statusCode!, `GET ${key}: ${res.statusCode} ${(await this.text(res)).slice(0, 200)}`);
    return { stream: res, size: Number(res.headers['content-length'] ?? 0), meta: metaOf(res) };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key, {}, {});
    res.resume();
    if (res.statusCode! >= 300 && res.statusCode !== 404) throw new S3Error(res.statusCode!, `DELETE ${key}: ${res.statusCode}`);
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix };
      if (token) q['continuation-token'] = token;
      const res = await this.send('GET', '', q, {});
      const xml = await this.text(res);
      if (res.statusCode! >= 300) throw new S3Error(res.statusCode!, `LIST ${prefix}: ${res.statusCode} ${xml.slice(0, 200)}`);
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const tag = (n: string) => m[1].match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`))?.[1] ?? '';
        out.push({ key: unxml(tag('Key')), size: Number(tag('Size')), lastModified: tag('LastModified') });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] : undefined;
      if (token) token = unxml(token);
    } while (token);
    return out;
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function metaOf(res: http.IncomingMessage): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (k.startsWith('x-amz-meta-') && typeof v === 'string') m[k.slice('x-amz-meta-'.length)] = v;
  return m;
}
