import { createCacheServer } from './server.ts';
import { FsStorage, S3Storage } from './storage.ts';
import { S3Client } from './s3.ts';

const env = process.env;
const tokens = (env.CACHE_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!tokens.length) throw new Error('CACHE_TOKENS is required (comma-separated bearer tokens)');

const storage = env.S3_BUCKET
  ? new S3Storage(
      new S3Client({
        endpoint: env.S3_ENDPOINT ?? `https://s3.${env.S3_REGION ?? 'us-east-1'}.amazonaws.com`,
        region: env.S3_REGION ?? 'auto',
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      }),
      env.S3_PREFIX ?? 'turbo',
    )
  : new FsStorage(env.CACHE_DIR ?? '.cache/turbo');

const port = Number(env.PORT ?? 3000);
createCacheServer({ storage, tokens, log: (l) => console.log(l) }).listen(port, env.HOST ?? '127.0.0.1', () => console.log(`turbo cache on :${port} (${env.S3_BUCKET ? 's3' : 'fs'})`));
