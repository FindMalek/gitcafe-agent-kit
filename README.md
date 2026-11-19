# gitcafe-agent-kit

Working fixes for gaps in the public GitCafe surface, built and tested only against public APIs. See `FINDINGS.md` for what was reproduced and what was not.

| package | what | status |
| --- | --- | --- |
| `packages/openapi-slicer` | verb operationIds, per-tag slices, per-operation docs, agent index | verified (live spec, validator) |
| `packages/cache` | Turborepo remote cache server (fs or S3/R2) and a `gitcafe-cache` action | verified with real turbo and local S3; not run on a GitCafe runner (no hosted runner available to this account) |
| `packages/rate-guard` | per-agent sliding-window guard reading `RateLimit-Policy` | verified (tests, 28-request benchmark) |
| `packages/task-runner` | claim issue, worktree, agent, `stack submit --dry-run`, then submit with provenance | verified on a real sandbox repo (one-commit stacks) |

Needs Node 24+ (runs `.ts` directly, no build) and Bun for the `cafe` CLI.

```sh
node --test packages/*/test/*.test.ts          # unit tests
node packages/openapi-slicer/src/cli.ts        # fetches the live spec into out/openapi
CACHE_TOKENS=secret node packages/cache/src/main.ts   # then TURBO_API=http://127.0.0.1:3000 TURBO_TOKEN=secret TURBO_TEAM=me
packages/cache/e2e/action.sh                   # action against a local S3 (needs rclone)
node packages/rate-guard/bench/bench.ts        # 28 requests, about 1 minute
```

Cache server env: `CACHE_TOKENS` (comma-separated bearer tokens), `PORT`, `HOST`, then either `CACHE_DIR` or `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX`. Teams are isolated by `teamId`/`slug`.
Cache action: GitCafe fetches remote actions from github.com, so `uses: FindMalek/gitcafe-agent-kit/packages/cache/action@main` works (pin a commit SHA in real use), or copy `packages/cache/action` to `.github/actions/gitcafe-cache` and use `./.github/actions/gitcafe-cache` (see `action.yml` for inputs). Cache entries are trusted: anyone with the bucket credentials can poison them, so give pull-request jobs a separate prefix.

Task runner: `node packages/task-runner/src/cli.ts --repo o/r --issue 12 --handle me --repo-dir . --agent-name x --model y -- <agent argv>`. It stops after `stack submit --dry-run` unless you pass `--submit`. Claiming is best effort: GitCafe has no lease, so it assigns, re-reads and backs off if someone else is also assigned.

Independent, unofficial. Not affiliated with GitCafe. Licence: MIT.
