export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

const NOUN_ALIASES: Record<string, string> = {
  pulls: 'PullRequest',
  repos: 'Repository',
  repositories: 'Repository',
  orgs: 'Org',
  organizations: 'Org',
  stacks: 'Stack',
  restacks: 'Restack',
  'gpg-keys': 'GpgKey',
  'ssh-keys': 'SshKey',
  'check-runs': 'CheckRun',
  'diff-files': 'DiffFile',
  'ref-updates': 'RefUpdate',
  'repo-retirements': 'RepoRetirement',
  'metadata-numbers': 'MetadataNumber',
  access_tokens: 'AccessToken',
};

const IRREGULAR_SINGULAR: Record<string, string> = {
  status: 'Status',
  statuses: 'Status',
  access: 'Access',
  mfa: 'Mfa',
  ci: 'Ci',
  jwks: 'Jwks',
  metrics: 'Metrics',
  settings: 'Settings',
  logs: 'Logs',
  'recovery-codes': 'RecoveryCodes',
  'filter-options': 'FilterOptions',
  options: 'Options',
  analysis: 'Analysis',
  address: 'Address',
  mirrors: 'Mirror',
  changes: 'Change',
  batches: 'Batch',
};

// verbs that undo another verb when the HTTP method is DELETE
const INVERSE: Record<string, string> = {
  lock: 'unlock',
  pin: 'unpin',
  star: 'unstar',
  hide: 'unhide',
  resolve: 'unresolve',
  stack: 'unstack',
  suspend: 'unsuspend',
  pause: 'resume',
  subscribe: 'unsubscribe',
  viewed: 'unviewed',
};

// segments that look plural but name a single resource/state
const NOT_COLLECTION = new Set([
  'status', 'access', 'settings', 'metrics', 'mfa', 'ci', 'jwks', 'logs', 'summary', 'overview',
  'filter-options', 'options', 'analysis', 'closure', 'changes', 'diff-files', 'viewed-files',
  'recovery-codes', 'default-branch', 'webhook-secret', 'capabilities', 'availability',
]);

export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

export function singular(seg: string): string {
  if (NOUN_ALIASES[seg]) return NOUN_ALIASES[seg];
  if (IRREGULAR_SINGULAR[seg]) return IRREGULAR_SINGULAR[seg];
  const p = pascal(seg);
  if (/ies$/.test(p)) return p.replace(/ies$/, 'y');
  if (/(ss|us|is)$/.test(p)) return p;
  if (/(sses|xes|ches|shes)$/.test(p)) return p.replace(/es$/, '');
  if (/s$/.test(p)) return p.slice(0, -1);
  return p;
}

const ALIAS_PLURAL: Record<string, string> = {
  pulls: 'PullRequests',
  repos: 'Repositories',
  repositories: 'Repositories',
  orgs: 'Orgs',
  organizations: 'Orgs',
};

export function plural(seg: string): string {
  if (NOT_COLLECTION.has(seg)) return singular(seg);
  if (ALIAS_PLURAL[seg]) return ALIAS_PLURAL[seg];
  if (/s$/.test(seg)) return NOUN_ALIASES[seg] ? NOUN_ALIASES[seg] + 's' : pascal(seg);
  const base = NOUN_ALIASES[seg] ?? pascal(seg);
  if (/y$/.test(base)) return base.replace(/y$/, 'ies');
  return /(x|ch|sh)$/.test(base) ? base + 'es' : base + 's';
}

function isCollection(seg: string): boolean {
  return /s$/.test(seg) && !NOT_COLLECTION.has(seg);
}

const ACTIONS = new Set([
  'close', 'reopen', 'draft', 'ready', 'lock', 'unlock', 'merge', 'cancel', 'rerun', 'rerequest', 'restore', 'resume',
  'pause', 'suspend', 'unsuspend', 'deny', 'approve', 'accept', 'reject', 'revoke', 'revoke-others', 'rotate', 'rotate-secret',
  'redeliver', 'sync', 'disconnect', 'reconnect', 'connect', 'dispatch', 'dismiss', 'resolve', 'unresolve', 'hide', 'unhide',
  'pin', 'unpin', 'star', 'unstar', 'land-through', 'restack', 'unstack', 'verify', 'confirm', 'complete', 'start', 'request',
  'renew', 'install', 'ping', 'reparent', 'archive', 'unarchive', 'logout', 'signin', 'signup', 'login', 'inspect', 'evaluate',
  'consume', 'authorize', 'register', 'checkout', 'transfer', 'fork', 'reconcile', 'cancel', 'tail', 'consent', 'callback', 'setup',
]);

const camel = (s: string) => lowerFirst(pascal(s));

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

export interface NameParts {
  verb: string;
  tail: string;
  repoScoped: boolean;
}

const VERB_BY_METHOD_ON_PARAM = { get: 'get', patch: 'update', put: 'replace', delete: 'delete', post: 'create', head: 'check', options: 'options' } as const;

/** Deterministic verb-style name derived from method + path. Pure function of its inputs. */
export function nameParts(method: HttpMethod, path: string): NameParts {
  const segs = path.split('/').filter((s) => s && s !== 'api' && s !== 'v1');
  const isParam = (s: string) => s.startsWith('{');
  let repoScoped = false;

  const parts: { name: string; param: boolean }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (isParam(s)) {
      if (parts.length) parts[parts.length - 1].param = true;
      continue;
    }
    if (s === 'repos' && isParam(segs[i + 1] ?? '') && isParam(segs[i + 2] ?? '')) {
      repoScoped = true;
      i += 2;
      continue;
    }
    parts.push({ name: s, param: false });
  }

  if (!parts.length) return { verb: VERB_BY_METHOD_ON_PARAM[method], tail: 'Repository', repoScoped };

  const last = parts[parts.length - 1];
  const heads = parts.slice(0, -1).map((p) => singular(p.name)).join('');
  const lastParam = isParam(segs[segs.length - 1]);
  const prevIsParam = isParam(segs[segs.length - 2] ?? '');
  const isAction = ACTIONS.has(last.name) && !lastParam && (method === 'post' || method === 'put' || method === 'delete');

  let verb: string;
  let tail: string;
  if (lastParam) {
    verb = /^\{action\}$/.test(segs[segs.length - 1]) ? 'run' : VERB_BY_METHOD_ON_PARAM[method];
    tail = heads + singular(last.name) + (verb === 'run' ? 'Action' : '');
  } else if (isAction) {
    if (method === 'delete') {
      const inv = INVERSE[last.name];
      verb = inv ?? 'delete';
      tail = heads + (inv ? '' : singular(last.name));
    } else {
      verb = camel(last.name);
      tail = heads;
    }
  } else if (isCollection(last.name)) {
    verb = { get: 'list', post: 'create', put: 'replace', patch: 'update', delete: 'clear', head: 'check', options: 'options' }[method];
    tail = heads + (['list', 'replace', 'clear'].includes(verb) ? plural(last.name) : singular(last.name));
  } else {
    // singleton noun: summary, milestone, review-draft, registration-token ...
    verb = { get: 'get', head: 'check', post: 'create', put: 'set', patch: 'update', delete: 'delete', options: 'options' }[method];
    tail = heads + singular(last.name);
  }
  void prevIsParam;
  return { verb, tail, repoScoped };
}

export function verbName(method: HttpMethod, path: string): string {
  const { verb, tail } = nameParts(method, path);
  return lowerFirst(verb + tail) || 'unnamed';
}

const SPECIAL: Record<string, string> = {
  'post /api/oauth/userinfo': 'getOauthUserinfo',
  'get /.well-known/webauthn': 'getWebauthnOrigins',
  'head /.well-known/webauthn': 'checkWebauthnOrigins',
  'get /auth.md': 'getAuthGuide',
  'get /.well-known/oauth-authorization-server': 'getOauthAuthorizationServerMetadata',
  'get /.well-known/openid-configuration': 'getOpenidConfiguration',
  'get /.well-known/oauth-protected-resource/api': 'getApiProtectedResourceMetadata',
  'get /.well-known/oauth-protected-resource/mcp': 'getMcpProtectedResourceMetadata',
};

export function nameOperation(method: HttpMethod, path: string): string {
  return SPECIAL[`${method} ${path}`] ?? verbName(method, path);
}

/**
 * Resolve collisions deterministically. A repo-scoped path loses to an unscoped one and gains a `Repo` infix
 * (getAttachment vs getRepoAttachment); anything still colliding gets a counter.
 */
export function dedupe(entries: { key: string; method: HttpMethod; path: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, typeof entries>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  const taken = new Set([...byName.keys()].filter((k) => byName.get(k)!.length === 1));
  for (const e of entries) if (byName.get(e.name)!.length === 1) out.set(e.key, e.name);

  for (const [name, group] of [...byName.entries()].filter(([, g]) => g.length > 1).sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    const scoped = (e: (typeof entries)[number]) => nameParts(e.method, e.path).repoScoped;
    group.forEach((e, i) => {
      let candidate = name;
      if (i > 0 || taken.has(name)) {
        const { verb, tail } = nameParts(e.method, e.path);
        candidate = scoped(e) ? lowerFirst(verb + 'Repo' + tail) : name;
        let n = 2;
        const base = candidate;
        while (taken.has(candidate)) candidate = base + n++;
      }
      taken.add(candidate);
      out.set(e.key, candidate);
    });
  }
  return out;
}
