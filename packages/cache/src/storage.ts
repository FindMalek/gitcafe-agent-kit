import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client } from './s3.ts';

export interface ArtifactMeta {
  duration?: string;
  tag?: string;
}

export interface Storage {
  put(key: string, body: Readable, size: number, meta: ArtifactMeta): Promise<void>;
  get(key: string): Promise<{ stream: Readable; size: number; meta: ArtifactMeta } | null>;
  head(key: string): Promise<{ size: number; meta: ArtifactMeta } | null>;
}

export class FsStorage implements Storage {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private p(key: string) {
    return join(this.root, key);
  }
  async put(key: string, body: Readable, _size: number, meta: ArtifactMeta) {
    const dest = this.p(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(body, createWriteStream(tmp));
      await writeFile(dest + '.meta.json', JSON.stringify(meta));
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async head(key: string) {
    const s = await stat(this.p(key)).catch(() => null);
    if (!s) return null;
    const meta = await readFile(this.p(key) + '.meta.json', 'utf8').then(JSON.parse, () => ({}));
    return { size: s.size, meta };
  }
  async get(key: string) {
    const h = await this.head(key);
    return h && { stream: createReadStream(this.p(key)), ...h };
  }
}

export class S3Storage implements Storage {
  private s3: S3Client;
  private prefix: string;
  constructor(s3: S3Client, prefix = 'turbo') {
    this.s3 = s3;
    this.prefix = prefix;
  }
  private k(key: string) {
    return `${this.prefix}/${key}`;
  }
  async put(key: string, body: Readable, size: number, meta: ArtifactMeta) {
    const m: Record<string, string> = {};
    if (meta.duration) m['artifact-duration'] = meta.duration;
    if (meta.tag) m['artifact-tag'] = meta.tag;
    await this.s3.put(this.k(key), body, size, m);
  }
  async head(key: string) {
    const h = await this.s3.head(this.k(key));
    return h && { size: h.size, meta: { duration: h.meta['artifact-duration'], tag: h.meta['artifact-tag'] } };
  }
  async get(key: string) {
    const g = await this.s3.get(this.k(key));
    return g && { stream: g.stream, size: g.size, meta: { duration: g.meta['artifact-duration'], tag: g.meta['artifact-tag'] } };
  }
}
