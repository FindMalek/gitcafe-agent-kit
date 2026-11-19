import { dedupe, nameOperation, type HttpMethod } from './naming.ts';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

type Json = any;

export interface OpRecord {
  id: string;
  was: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  webhook?: boolean;
}

export interface SliceResult {
  slices: Map<string, Json>;
  ops: OpRecord[];
  renameMap: Record<string, string>;
  lock: Record<string, string>;
}

export const tagFile = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function collectRefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((n) => collectRefs(n, into));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') into.add(v);
      else collectRefs(v, into);
    }
  }
}

function closure(spec: Json, seeds: Json[]): Set<string> {
  const seen = new Set<string>();
  const queue = new Set<string>();
  seeds.forEach((s) => collectRefs(s, queue));
  while (queue.size) {
    const ref = queue.values().next().value as string;
    queue.delete(ref);
    if (seen.has(ref) || !ref.startsWith('#/')) continue;
    seen.add(ref);
    const target = ref.slice(2).split('/').reduce((n: Json, k) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    collectRefs(target, queue);
  }
  return seen;
}

export function slice(spec: Json, lock: Record<string, string> = {}): SliceResult {
  const flat: { key: string; method: HttpMethod; path: string; name: string; op: Json; webhook?: boolean }[] = [];
  for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
    for (const m of METHODS) {
      if (item[m]) flat.push({ key: `${m} ${path}`, method: m, path, name: nameOperation(m, path), op: item[m] });
    }
  }
  const computed = dedupe(flat);
  const renamed = new Map<string, string>();
  const used = new Set(Object.values(lock));
  for (const f of flat) if (lock[f.key]) renamed.set(f.key, lock[f.key]);
  for (const f of flat) {
    if (renamed.has(f.key)) continue;
    let id = computed.get(f.key)!;
    const base = id;
    for (let n = 2; used.has(id); n++) id = base + n;
    used.add(id);
    renamed.set(f.key, id);
  }

  const ops: OpRecord[] = [];
  const renameMap: Record<string, string> = {};
  const byTag = new Map<string, { paths: Json; webhooks: Json }>();
  const bucket = (t: string) => {
    if (!byTag.has(t)) byTag.set(t, { paths: {}, webhooks: {} });
    return byTag.get(t)!;
  };

  for (const f of flat) {
    const id = renamed.get(f.key)!;
    const tag = f.op.tags?.[0] ?? 'Untagged';
    renameMap[f.op.operationId] = id;
    ops.push({ id, was: f.op.operationId, method: f.method.toUpperCase(), path: f.path, tag, summary: f.op.summary ?? '' });
    const b = bucket(tag);
    b.paths[f.path] ??= Object.fromEntries(Object.entries(spec.paths[f.path]).filter(([k]) => !METHODS.includes(k as HttpMethod)));
    b.paths[f.path][f.method] = { ...f.op, operationId: id, 'x-legacy-operationId': f.op.operationId };
  }

  // webhook events keep their existing readable ids (webhooks.issueCreated)
  for (const [event, item] of Object.entries<Json>(spec.webhooks ?? {})) {
    for (const m of METHODS) {
      if (!item[m]) continue;
      const tag = 'Webhook events';
      bucket(tag).webhooks[event] = item;
      ops.push({ id: item[m].operationId, was: item[m].operationId, method: `EVENT`, path: event, tag, summary: item[m].summary ?? '', webhook: true });
    }
  }

  const slices = new Map<string, Json>();
  for (const [tag, { paths, webhooks }] of [...byTag].sort(([a], [b]) => a.localeCompare(b))) {
    const refs = closure(spec, [paths, webhooks]);
    const components: Json = {};
    for (const ref of [...refs].sort()) {
      const [, , kind, name] = ref.split('/');
      if (!kind || !name) continue;
      (components[kind] ??= {})[name] = spec.components[kind][name];
    }
    const secNames = new Set<string>();
    JSON.stringify([paths, webhooks], (k, v) => (k === 'security' && Array.isArray(v) ? (v.forEach((r) => Object.keys(r).forEach((n) => secNames.add(n))), v) : v));
    for (const n of secNames) if (spec.components.securitySchemes?.[n]) (components.securitySchemes ??= {})[n] = spec.components.securitySchemes[n];

    slices.set(tag, {
      openapi: spec.openapi,
      info: { ...spec.info, title: `${spec.info.title} — ${tag}` },
      servers: spec.servers,
      tags: [{ name: tag }],
      'x-gc2-ratelimit-policies': spec['x-gc2-ratelimit-policies'],
      paths,
      ...(Object.keys(webhooks).length ? { webhooks } : {}),
      components,
    });
  }
  const newLock: Record<string, string> = {};
  for (const f of flat) newLock[f.key] = renamed.get(f.key)!;
  return { slices, ops, renameMap, lock: newLock };
}

export function danglingRefs(slice: Json): string[] {
  const refs = new Set<string>();
  collectRefs(slice, refs);
  return [...refs].filter((r) => {
    if (!r.startsWith('#/')) return false;
    return !r.slice(2).split('/').reduce((n: Json, k) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], slice);
  });
}

/** One operation plus only the components it reaches, as a standalone OpenAPI doc. */
export function extractOperation(tagSlice: Json, path: string, method: string): Json {
  const m = method.toLowerCase();
  const item = tagSlice.paths[path];
  const paths = { [path]: { ...Object.fromEntries(Object.entries(item).filter(([k]) => !METHODS.includes(k as HttpMethod))), [m]: item[m] } };
  const refs = closure(tagSlice, [paths]);
  const components: Json = {};
  for (const ref of [...refs].sort()) {
    const [, , kind, name] = ref.split('/');
    if (kind && name) (components[kind] ??= {})[name] = tagSlice.components[kind][name];
  }
  const sec = new Set<string>();
  for (const r of item[m].security ?? []) Object.keys(r).forEach((n) => sec.add(n));
  for (const n of sec) if (tagSlice.components.securitySchemes?.[n]) (components.securitySchemes ??= {})[n] = tagSlice.components.securitySchemes[n];
  return { openapi: tagSlice.openapi, info: tagSlice.info, servers: tagSlice.servers, 'x-gc2-ratelimit-policies': tagSlice['x-gc2-ratelimit-policies'], paths, components };
}
